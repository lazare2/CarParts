// repairmen who send customers (referrers), their commissions and the payments made to them
import { db } from '../db.js';
import { route } from './router.js';
import { paidCommission } from './sales.js';
import {
  HttpError, round2, today, month, run, insertId, cleanName, textIn, dateIn, moneyIn, pctIn, getReferrer, must, partInfo,
} from './util.js';

const RESP = { us: 'ჩვენი ბრალი', referrer: 'ხელოსნის ბრალი', customer: 'მყიდველმა გადაიფიქრა', '': '' };

// Every sale line sent by a repairman earns commission in the month of the sale. A return/exchange
// decision is one separate 'adjust' line (in the month it was decided) that says where it comes from;
// the returned/new parts themselves are listed with 0 so the sales numbers stay visible.
// Plain returns from before version 2.2 keep their own (negative) line.
function commissionEntries(referrerId = null) {
  const filter = referrerId ? 'AND s.referrer_id = ?' : '';
  const params = referrerId ? [referrerId] : [];
  const sales = db.prepare(`
    SELECT s.referrer_id, s.id AS sale_id, si.id AS item_id, s.date, l.part_id, si.quantity, si.damaged,
           si.price_gel AS price, si.commission_pct AS pct, si.commission_gel AS amount, 'sale' AS kind, s.exchange_id
    FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN lots l ON l.id = si.lot_id
    WHERE s.referrer_id IS NOT NULL ${filter}`).all(...params);
  const returns = db.prepare(`
    SELECT r.referrer_id, si.sale_id, si.id AS item_id, r.date, l.part_id, r.quantity, COALESCE(si.damaged, 0) AS damaged,
           -r.refund_gel AS price, COALESCE(si.commission_pct, e.commission_pct, 0) AS pct, -r.commission_back_gel AS amount,
           'return' AS kind, r.exchange_id
    FROM returns r JOIN lots l ON l.id = r.lot_id LEFT JOIN sale_items si ON si.id = r.sale_item_id
    LEFT JOIN exchanges e ON e.id = r.exchange_id
    WHERE r.referrer_id IS NOT NULL ${filter.replace('s.referrer_id', 'r.referrer_id')}`).all(...params);
  const info = partInfo();
  const lotPart = new Map(db.prepare('SELECT id, part_id FROM lots').all().map((l) => [l.id, l.part_id]));
  const adjust = db.prepare(`SELECT e.*, s.date AS sale_date FROM exchanges e LEFT JOIN sales s ON s.id = e.sale_id
    WHERE e.referrer_id IS NOT NULL AND e.commission_applied = 1 ${referrerId ? 'AND e.referrer_id = ?' : ''}`).all(...params).map((e) => {
    const back = db.prepare('SELECT lot_id, quantity, commission_back_gel FROM returns WHERE exchange_id = ?').all(e.id);
    const taken = db.prepare('SELECT si.lot_id, si.quantity, si.commission_gel FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.exchange_id = ?').all(e.id);
    const amount = round2(taken.reduce((x, t) => x + t.commission_gel, 0) - back.reduce((x, r) => x + r.commission_back_gel, 0));
    const names = (rows) => rows.map((r) => `${info.get(lotPart.get(r.lot_id)).label}${r.quantity > 1 ? ` ×${r.quantity}` : ''}`).join(', ');
    return {
      referrer_id: e.referrer_id, exchange_id: e.id, date: e.commission_changed_at ?? e.date, kind: 'adjust', amount,
      price: 0, quantity: null, pct: e.commission_pct, item_id: null, part_id: null, damaged: 0,
      label: `კორექცია: ${e.sale_date ? `შეკვეთა ${e.sale_date.split('-').reverse().join('.')}` : 'შეკვეთის გარეშე'}`,
      detail: [`დაბრუნდა: ${names(back)}`, taken.length ? `აიღო: ${names(taken)}` : '', RESP[e.responsible], e.note].filter(Boolean).join(' · '),
    };
  });
  // the parts themselves: their commission now sits in the adjust line
  for (const x of sales) if (x.exchange_id) x.amount = 0;
  for (const x of returns) if (x.exchange_id) x.amount = 0;
  return [...sales, ...returns, ...adjust];
}

// commission from normal sales, the effect of returns/exchanges (+ extra / - taken back), payments
function balance(entries, payments) {
  const sales = entries.filter((e) => e.kind === 'sale' && !e.exchange_id).reduce((s, e) => s + e.amount, 0);
  const adjust = entries.filter((e) => e.kind === 'return' || e.kind === 'adjust').reduce((s, e) => s + e.amount, 0);
  const paid = payments.reduce((s, p) => s + p.amount_gel, 0);
  return { from_sales: round2(sales), from_returns: round2(adjust), paid: round2(paid), owed: round2(sales + adjust - paid) };
}

export function owedTo(referrerId) {
  return balance(commissionEntries(referrerId), paymentsOf(referrerId)).owed;
}

function paymentsOf(referrerId = null) {
  return referrerId
    ? db.prepare('SELECT * FROM referrer_payments WHERE referrer_id = ? ORDER BY date DESC, id DESC').all(referrerId)
    : db.prepare('SELECT * FROM referrer_payments').all();
}

function referrerInput(body) {
  return {
    name: cleanName(body.name, 'სახელი'),
    phone: textIn(body.phone),
    pct: body.default_pct === '' || body.default_pct == null ? null : pctIn(body.default_pct, 'ნაგულისხმევი პროცენტი'),
    note: textIn(body.note),
    active: body.active === false || body.active === 0 || body.active === '0' ? 0 : 1,
  };
}

route('GET', '/api/referrers', () => {
  const thisMonth = month(today());
  const earned = new Map();
  for (const e of commissionEntries()) {
    const t = earned.get(e.referrer_id) ?? { total: 0, month: 0, sales: 0, customers: new Set() };
    t.total += e.amount;
    if (month(e.date) === thisMonth) t.month += e.amount;
    if (e.kind === 'sale') { t.sales += e.price; if (!e.exchange_id) t.customers.add(e.sale_id); }
    earned.set(e.referrer_id, t);
  }
  const paid = new Map();
  for (const p of paymentsOf()) paid.set(p.referrer_id, (paid.get(p.referrer_id) ?? 0) + p.amount_gel);

  const all = commissionEntries();
  const allPayments = paymentsOf();
  return db.prepare('SELECT * FROM referrers ORDER BY active DESC, name COLLATE NOCASE').all().map((r) => {
    const b = balance(all.filter((e) => e.referrer_id === r.id), allPayments.filter((p) => p.referrer_id === r.id));
    const t = earned.get(r.id) ?? { total: 0, month: 0, sales: 0, customers: new Set() };
    const p = paid.get(r.id) ?? 0;
    return {
      ...r,
      earned: round2(t.total), earned_month: round2(t.month), sales_total: round2(t.sales), visits: t.customers.size,
      paid: round2(p), owed: round2(t.total - p), from_sales: b.from_sales, from_returns: b.from_returns,
    };
  });
});

route('GET', '/api/referrers/:id', (body, id) => {
  const referrer = getReferrer(id);
  const info = partInfo();
  const paidOf = paidCommission();
  const backOf = new Map(db.prepare(`SELECT sale_item_id, SUM(commission_back_gel) AS back FROM returns
    WHERE sale_item_id IS NOT NULL GROUP BY sale_item_id`).all().map((r) => [r.sale_item_id, r.back]));
  const editsOf = new Map();
  for (const e of db.prepare(`SELECT ce.* FROM commission_edits ce JOIN sale_items si ON si.id = ce.sale_item_id
      JOIN sales s ON s.id = si.sale_id WHERE s.referrer_id = ? ORDER BY ce.id`).all(id))
    (editsOf.get(e.sale_item_id) ?? editsOf.set(e.sale_item_id, []).get(e.sale_item_id)).push(e);
  const months = new Map();
  let earned = 0;
  for (const e of commissionEntries(id)) {
    const m = month(e.date);
    if (!months.has(m)) months.set(m, { month: m, earned: 0, sales: 0, lines: [] });
    const entry = months.get(m);
    entry.earned += e.amount;
    entry.sales += e.price;
    entry.lines.push({
      ...e, label: e.label ?? info.get(e.part_id).label, amount: round2(e.amount), price: round2(e.price),
      ...(e.kind === 'sale' ? {
        paid_gel: paidOf.get(e.item_id) ?? 0, edits: editsOf.get(e.item_id) ?? [],
        net_gel: round2(e.amount - (backOf.get(e.item_id) ?? 0)),   // what is left after commission taken back on returns
      } : {}),
    });
    earned += e.amount;
  }
  const payments = paymentsOf(id);
  const paid = payments.reduce((sum, p) => sum + p.amount_gel, 0);
  const entries = commissionEntries(id);
  const b = balance(entries, payments);
  // what the next payment is made of: what was left after the last payment + everything since then
  const last = payments[0]?.date ?? null;
  const carried = last ? round2(entries.filter((e) => e.date <= last).reduce((x, e) => x + e.amount, 0) - b.paid) : 0;
  const since = entries.filter((e) => (!last || e.date > last) && Math.abs(e.amount) > 0.004)
    .map((e) => ({ date: e.date, kind: e.kind, amount: round2(e.amount), label: e.label ?? info.get(e.part_id).label, detail: e.detail ?? '' }))
    .sort((x, y) => x.date.localeCompare(y.date));
  return {
    referrer,
    earned: round2(earned),
    paid: round2(paid),
    owed: round2(earned - paid),
    from_sales: b.from_sales,
    from_returns: b.from_returns,
    since_last_payment: { last_date: last, carried, lines: since },
    months: [...months.values()]
      .map((m) => ({
        ...m, earned: round2(m.earned), sales: round2(m.sales),
        lines: m.lines.sort((a, b) => b.date.localeCompare(a.date) || (b.item_id ?? 0) - (a.item_id ?? 0)),
      }))
      .sort((a, b) => b.month.localeCompare(a.month)),
    payments,
    edits: [...editsOf.values()].flat().map((e) => {
      const line = db.prepare(`SELECT l.part_id, s.date AS sale_date FROM sale_items si JOIN lots l ON l.id = si.lot_id
        JOIN sales s ON s.id = si.sale_id WHERE si.id = ?`).get(e.sale_item_id);
      return { ...e, label: info.get(line.part_id).label, sale_date: line.sale_date };
    }).sort((a, b) => b.id - a.id),
  };
});

route('POST', '/api/referrers', (body) => {
  const r = referrerInput(body);
  return {
    id: insertId('INSERT INTO referrers (name, phone, default_pct, note, active) VALUES (?, ?, ?, ?, ?)',
      [r.name, r.phone, r.pct, r.note, r.active], 'ასეთი სახელით ხელოსანი უკვე არსებობს'),
  };
});

route('PATCH', '/api/referrers/:id', (body, id) => {
  getReferrer(id);
  const r = referrerInput(body);
  run('UPDATE referrers SET name = ?, phone = ?, default_pct = ?, note = ?, active = ? WHERE id = ?',
    [r.name, r.phone, r.pct, r.note, r.active, id], 'ასეთი სახელით ხელოსანი უკვე არსებობს');
  return { ok: true };
});

route('DELETE', '/api/referrers/:id', (body, id) => {
  getReferrer(id);
  if (db.prepare('SELECT 1 FROM sales WHERE referrer_id = ?').get(id) || db.prepare('SELECT 1 FROM referrer_payments WHERE referrer_id = ?').get(id))
    throw new HttpError(409, 'ამ ხელოსანს უკვე აქვს გაყიდვები ან გადახდები. წაშლის ნაცვლად გახადეთ არააქტიური.');
  db.prepare('DELETE FROM referrers WHERE id = ?').run(id);
  return { ok: true };
});

route('POST', '/api/referrers/:id/payments', (body, id) => {
  getReferrer(id);
  const amount = moneyIn(body.amount, 'გადახდილი თანხა', { positive: true });
  return {
    id: insertId('INSERT INTO referrer_payments (referrer_id, date, amount, currency, rate, amount_gel, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, dateIn(body.date), amount.amount, amount.currency, amount.rate, amount.gel, textIn(body.note)]),
  };
});

route('DELETE', '/api/payments/:id', (body, id) => {
  must(db.prepare('SELECT id FROM referrer_payments WHERE id = ?').get(id), 'გადახდა ვერ მოიძებნა');
  db.prepare('DELETE FROM referrer_payments WHERE id = ?').run(id);
  return { ok: true };
});
