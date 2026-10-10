// returns and exchanges: a customer brings parts back (from a known order or not) and maybe takes others instead
import { db } from '../db.js';
import { route } from './router.js';
import { addEvent } from './containers.js';
import { addSaleItems } from './sales.js';
import {
  HttpError, round2, today, transaction, insertId, textIn, dateIn, currencyIn, amountIn, pctIn, posInt, toGel,
  getReferrer, getLot, must, partInfo,
} from './util.js';

const RESPONSIBLE = ['us', 'referrer', 'customer'];

// spread an amount over rows by weight (rounded to tetri, the rest on the last row), each capped
function spread(total, rows, weight, cap = () => Infinity) {
  const sum = rows.reduce((s, r) => s + weight(r), 0);
  let left = round2(total);
  return rows.map((r, i) => {
    const share = i === rows.length - 1 ? left : round2((total * weight(r)) / (sum || 1));
    const amount = Math.max(0, Math.min(share, cap(r), left));
    left = round2(left - amount);
    return round2(amount);
  });
}

route('POST', '/api/exchanges', (body) => {
  const date = dateIn(body.date);
  const { currency, rate } = currencyIn(body.currency, body.rate, 'დაბრუნება');
  const responsible = RESPONSIBLE.includes(body.responsible) ? body.responsible : '';
  const returned = Array.isArray(body.returned) ? body.returned : [];
  const newItems = Array.isArray(body.new_items) ? body.new_items : [];
  if (!returned.length) throw new HttpError(400, 'აირჩიეთ, რა დააბრუნა მყიდველმა');
  const info = partInfo();

  // ----- what comes back -----
  let sale = null;
  const usedItem = new Map();   // the same order line / lot may appear twice in one request
  const usedLot = new Map();
  const lines = returned.map((r) => {
    const quantity = posInt(r.quantity, 'დაბრუნებული რაოდენობა');
    const condition = r.condition === 'good' ? 'good' : 'damaged';
    if (r.sale_item_id) {
      const item = must(db.prepare('SELECT * FROM sale_items WHERE id = ?').get(Number(r.sale_item_id)), 'შეკვეთის ნაწილი ვერ მოიძებნა');
      if (sale && item.sale_id !== sale.id) throw new HttpError(400, 'ერთ ჯერზე ერთი შეკვეთის ნაწილების დაბრუნებაა შესაძლებელი');
      sale ??= db.prepare('SELECT * FROM sales WHERE id = ?').get(item.sale_id);
      const label = info.get(getLot(item.lot_id).part_id).label;
      const credit = amountIn(r.credit, `${label}: დასაბრუნებელი თანხა`);
      const before = db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS qty, COALESCE(SUM(refund_gel), 0) AS refund,
        COALESCE(SUM(commission_back_gel), 0) AS back FROM returns WHERE sale_item_id = ?`).get(item.id);
      const used = usedItem.get(item.id) ?? { qty: 0, gel: 0 };
      const left = item.quantity - before.qty - used.qty;
      if (quantity > left) throw new HttpError(400, `${label}: დასაბრუნებლად დარჩენილია მხოლოდ ${left} ცალი`);
      const creditGel = toGel(credit, rate);
      const refundable = round2(item.price_gel - before.refund - used.gel);
      if (creditGel > refundable + 0.001) throw new HttpError(400, `${label}: დასაბრუნებელი თანხა ვერ იქნება ${refundable} ₾-ზე მეტი`);
      usedItem.set(item.id, { qty: used.qty + quantity, gel: used.gel + creditGel });
      return { item, lot_id: item.lot_id, quantity, condition, credit, creditGel, label,
        commissionLeft: round2(item.commission_gel - before.back) };
    }
    // the order is not known: the part goes back into a container that sold it
    const lot = getLot(Number(r.lot_id));
    const label = info.get(lot.part_id).label;
    const credit = amountIn(r.credit, `${label}: დასაბრუნებელი თანხა`);
    const sold = db.prepare('SELECT sold FROM lot_stats WHERE lot_id = ?').get(lot.id).sold - (usedLot.get(lot.id) ?? 0);
    if (quantity > sold) throw new HttpError(400, `${label}: ამ კონტეინერიდან გაყიდულია მხოლოდ ${sold} ცალი`);
    usedLot.set(lot.id, (usedLot.get(lot.id) ?? 0) + quantity);
    return { item: null, lot_id: lot.id, quantity, condition, credit, creditGel: toGel(credit, rate), label };
  });

  // ----- the repairman and his commission -----
  let referrer = null;
  if (sale?.referrer_id) referrer = getReferrer(sale.referrer_id);
  else if (!sale && body.referrer_id) referrer = getReferrer(Number(body.referrer_id));
  let pct = 0;
  if (referrer) {
    if (body.commission_pct !== '' && body.commission_pct != null) pct = pctIn(body.commission_pct);
    else if (sale) {
      // the % the returned parts were sold with (weighted by their price)
      const price = lines.reduce((s, l) => s + (l.item.price_gel * l.quantity) / l.item.quantity, 0);
      const com = lines.reduce((s, l) => s + (l.item.commission_gel * l.quantity) / l.item.quantity, 0);
      pct = price > 0 ? round2((com / price) * 100) : 0;
    } else pct = referrer.default_pct ?? 0;
  }

  const creditGel = round2(lines.reduce((s, l) => s + l.creditGel, 0));
  const newGel = round2(newItems.reduce((s, n) => s + toGel(amountIn(n.price, 'ახალი ნაწილის ფასი'), rate), 0));
  // what the commission would change by: + more for a pricier part, - take back for a cheaper one / a plain return
  const delta = referrer ? round2((pct / 100) * (newGel - creditGel)) : 0;
  const applied = referrer && delta !== 0 && !!body.apply_commission ? 1 : 0;

  return transaction(() => {
    const exchangeId = insertId(`INSERT INTO exchanges (date, sale_id, referrer_id, responsible, currency, rate, credit_gel, new_gel,
      cash_gel, commission_pct, commission_delta_gel, commission_applied, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [date, sale?.id ?? null, referrer?.id ?? null, responsible, currency, rate, creditGel, newGel, round2(newGel - creditGel),
      pct, delta, applied, textIn(body.note)]);

    const returnIds = lines.map((l) => {
      db.prepare(`UPDATE lots SET ${l.condition === 'good' ? 'good = good' : 'damaged = damaged'} + ? WHERE id = ?`).run(l.quantity, l.lot_id);
      addEvent(l.lot_id, date, 'returned', l.condition === 'good' ? l.quantity : 0, l.condition === 'good' ? 0 : l.quantity, textIn(body.note));
      return insertId(`INSERT INTO returns (exchange_id, sale_item_id, lot_id, referrer_id, date, quantity, condition,
        refund_amount, refund_currency, refund_rate, refund_gel, commission_back_gel, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [exchangeId, l.item?.id ?? null, l.lot_id, referrer?.id ?? null, date, l.quantity, l.condition, l.credit, currency, rate,
        l.creditGel, textIn(body.note)]);
    });

    let newSaleId = null;
    if (newItems.length) {
      newSaleId = insertId('INSERT INTO sales (date, referrer_id, currency, rate, note, exchange_id) VALUES (?, ?, ?, ?, ?, ?)',
        [date, referrer?.id ?? null, currency, rate, 'გაცვლა', exchangeId]);
      addSaleItems(newSaleId, newItems, { rate, pct: () => 0 });
    }

    if (applied && delta < 0) {
      // take the commission back from the returned parts (never more than they earned)
      const backs = spread(-delta, lines, (l) => l.creditGel, (l) => (l.item ? l.commissionLeft : Infinity));
      backs.forEach((b, i) => db.prepare('UPDATE returns SET commission_back_gel = ? WHERE id = ?').run(b, returnIds[i]));
    }
    if (applied && delta > 0 && newSaleId) {
      // extra commission on the pricier new parts
      const items = db.prepare('SELECT id, price_gel FROM sale_items WHERE sale_id = ?').all(newSaleId);
      spread(delta, items, (it) => it.price_gel).forEach((c, i) =>
        db.prepare('UPDATE sale_items SET commission_gel = ?, commission_pct = ? WHERE id = ?').run(c, pct, items[i].id));
    }
    return { id: exchangeId, cash_gel: round2(newGel - creditGel), commission_delta: delta };
  });
});

// list of returns/exchanges, newest first (?referrer_id= for one repairman); older plain returns included
route('GET', '/api/exchanges', (query) => {
  const info = partInfo();
  const refFilter = query.referrer_id ? Number(query.referrer_id) : null;
  const names = new Map(db.prepare('SELECT id, name FROM referrers').all().map((r) => [r.id, r.name]));
  const containerOfLot = new Map(db.prepare('SELECT l.id, l.part_id, c.name FROM lots l JOIN containers c ON c.id = l.container_id').all()
    .map((l) => [l.id, l]));
  const lotLine = (lotId) => ({ label: info.get(containerOfLot.get(lotId).part_id).label, container: containerOfLot.get(lotId).name });

  const returnsOf = db.prepare('SELECT * FROM returns WHERE exchange_id = ? ORDER BY id');
  const newItemsOf = db.prepare(`SELECT si.* FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.exchange_id = ? ORDER BY si.id`);
  const saleDate = db.prepare('SELECT date FROM sales WHERE id = ?');
  const list = db.prepare('SELECT * FROM exchanges ORDER BY date DESC, id DESC').all()
    .filter((e) => !refFilter || e.referrer_id === refFilter)
    .map((e) => {
      const back = returnsOf.all(e.id);
      const taken = newItemsOf.all(e.id);
      return {
        ...e, referrer: names.get(e.referrer_id) ?? null, sale_date: e.sale_id ? saleDate.get(e.sale_id)?.date : null,
        returned: back.map((r) => ({ ...lotLine(r.lot_id), quantity: r.quantity, condition: r.condition, credit_gel: r.refund_gel,
          commission_back_gel: r.commission_back_gel, from_order: !!r.sale_item_id })),
        taken: taken.map((t) => ({ ...lotLine(t.lot_id), quantity: t.quantity, damaged: !!t.damaged, price_gel: t.price_gel,
          commission_gel: t.commission_gel })),
        can_undo: canUndo(back, taken),
      };
    });
  const legacy = db.prepare('SELECT * FROM returns WHERE exchange_id IS NULL ORDER BY date DESC, id DESC').all()
    .filter((r) => !refFilter || r.referrer_id === refFilter)
    .map((r) => ({
      id: null, legacy: true, date: r.date, referrer_id: r.referrer_id, referrer: names.get(r.referrer_id) ?? null,
      credit_gel: r.refund_gel, new_gel: 0, cash_gel: -r.refund_gel, responsible: '', note: r.note,
      commission_delta_gel: -r.commission_back_gel, commission_applied: r.commission_back_gel > 0 ? 1 : 0,
      returned: [{ ...lotLine(r.lot_id), quantity: r.quantity, condition: r.condition, credit_gel: r.refund_gel,
        commission_back_gel: r.commission_back_gel, from_order: !!r.sale_item_id }],
      taken: [], can_undo: false,
    }));
  return [...list, ...legacy].sort((a, b) => b.date.localeCompare(a.date));
});

// undo is only possible while the returned units are still there and the new parts were not returned themselves
function canUndo(back, taken) {
  for (const r of back) {
    const lot = getLot(r.lot_id);
    if ((r.condition === 'good' ? lot.good : lot.damaged) < r.quantity) return false;
  }
  return !taken.some((t) => db.prepare('SELECT 1 FROM returns WHERE sale_item_id = ?').get(t.id));
}

route('DELETE', '/api/exchanges/:id', (body, id) => {
  must(db.prepare('SELECT id FROM exchanges WHERE id = ?').get(id), 'დაბრუნება ვერ მოიძებნა');
  const back = db.prepare('SELECT * FROM returns WHERE exchange_id = ?').all(id);
  const newSale = db.prepare('SELECT id FROM sales WHERE exchange_id = ?').get(id);
  const taken = newSale ? db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(newSale.id) : [];
  if (taken.some((t) => db.prepare('SELECT 1 FROM returns WHERE sale_item_id = ?').get(t.id)))
    throw new HttpError(409, 'გაცვლით აღებული ნაწილი უკვე დაბრუნდა, ამიტომ ვერ გაუქმდება');
  const info = partInfo();
  transaction(() => {
    for (const r of back) {
      const lot = getLot(r.lot_id);
      const have = r.condition === 'good' ? lot.good : lot.damaged;
      if (have < r.quantity)
        throw new HttpError(409, `${info.get(lot.part_id).label}: დაბრუნებული ნაწილი უკვე აღარ არის მარაგში, ამიტომ ვერ გაუქმდება`);
      db.prepare(`UPDATE lots SET ${r.condition === 'good' ? 'good = good' : 'damaged = damaged'} - ? WHERE id = ?`).run(r.quantity, lot.id);
      addEvent(lot.id, today(), 'correction', r.condition === 'good' ? -r.quantity : 0, r.condition === 'good' ? 0 : -r.quantity,
        'დაბრუნების გაუქმება');
    }
    db.prepare('DELETE FROM returns WHERE exchange_id = ?').run(id);
    if (newSale) {
      for (const t of taken)
        db.prepare(`UPDATE lots SET ${t.damaged ? 'damaged = damaged' : 'good = good'} + ? WHERE id = ?`).run(t.quantity, t.lot_id);
      db.prepare('DELETE FROM sales WHERE id = ?').run(newSale.id);
    }
    db.prepare('DELETE FROM exchanges WHERE id = ?').run(id);
  });
  return { ok: true };
});
