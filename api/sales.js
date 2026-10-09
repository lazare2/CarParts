// sales (one receipt with several parts), cancelling a sale, returns
import { db } from '../db.js';
import { route } from './router.js';
import { addEvent } from './containers.js';
import {
  HttpError, round2, transaction, insertId, textIn, dateIn, currencyIn, amountIn, moneyIn, pctIn, posInt, toGel,
  getReferrer, getLot, must, partInfo,
} from './util.js';

route('POST', '/api/sales', (body) => {
  const date = dateIn(body.date);
  const referrerId = body.referrer_id ? Number(body.referrer_id) : null;
  if (referrerId) getReferrer(referrerId);
  const { currency, rate } = currencyIn(body.currency, body.rate, 'გაყიდვა');
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'კალათა ცარიელია');
  const info = partInfo();

  return transaction(() => {
    const saleId = insertId('INSERT INTO sales (date, referrer_id, currency, rate, note) VALUES (?, ?, ?, ?, ?)',
      [date, referrerId, currency, rate, textIn(body.note)]);
    for (const item of items) {
      const lot = getLot(Number(item.lot_id));          // read again each time: two lines may use the same lot
      const label = info.get(lot.part_id).label;
      const quantity = posInt(item.quantity, `${label}: რაოდენობა`);
      const damaged = item.damaged ? 1 : 0;
      const available = damaged ? lot.damaged : lot.good;
      if (quantity > available)
        throw new HttpError(400, `${label}: ${damaged ? 'დაზიანებული ' : ''}მარაგში მხოლოდ ${available} ცალია`);
      const price = amountIn(item.price, `${label}: ფასი`);
      const priceGel = toGel(price, rate);
      const pct = referrerId ? pctIn(item.commission_pct, `${label}: საკომისიო`) : 0;
      db.prepare(`UPDATE lots SET ${damaged ? 'damaged = damaged' : 'good = good'} - ? WHERE id = ?`).run(quantity, lot.id);
      db.prepare(`INSERT INTO sale_items (sale_id, lot_id, quantity, damaged, price_amount, price_gel, commission_pct, commission_gel)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(saleId, lot.id, quantity, damaged, price, priceGel, pct, round2((priceGel * pct) / 100));
    }
    return { id: saleId };
  });
});

// undo a sale entered by mistake: everything goes back to stock
route('DELETE', '/api/sales/:id', (body, id) => {
  must(db.prepare('SELECT id FROM sales WHERE id = ?').get(id), 'გაყიდვა ვერ მოიძებნა');
  if (db.prepare('SELECT 1 FROM returns r JOIN sale_items si ON si.id = r.sale_item_id WHERE si.sale_id = ?').get(id))
    throw new HttpError(409, 'ამ გაყიდვაზე უკვე დაფიქსირდა დაბრუნება, ამიტომ ვერ გაუქმდება');
  transaction(() => {
    for (const item of db.prepare('SELECT lot_id, quantity, damaged FROM sale_items WHERE sale_id = ?').all(id))
      db.prepare(`UPDATE lots SET ${item.damaged ? 'damaged = damaged' : 'good = good'} + ? WHERE id = ?`).run(item.quantity, item.lot_id);
    db.prepare('DELETE FROM sales WHERE id = ?').run(id);
  });
  return { ok: true };
});

// a customer brought (part of) a sale item back
route('POST', '/api/sale-items/:id/return', (body, id) => {
  const item = must(db.prepare('SELECT * FROM sale_items WHERE id = ?').get(id), 'გაყიდვა ვერ მოიძებნა');
  const quantity = posInt(body.quantity, 'დაბრუნებული რაოდენობა');
  const condition = body.condition === 'good' ? 'good' : 'damaged';
  const refund = moneyIn(body.refund, 'დაბრუნებული თანხა');
  const date = dateIn(body.date);
  const before = db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS qty, COALESCE(SUM(refund_gel), 0) AS refund,
    COALESCE(SUM(commission_back_gel), 0) AS back FROM returns WHERE sale_item_id = ?`).get(id);

  if (quantity > item.quantity - before.qty)
    throw new HttpError(400, `დასაბრუნებლად დარჩენილია მხოლოდ ${item.quantity - before.qty} ცალი`);
  const refundable = round2(item.price_gel - before.refund);
  if (refund.gel > refundable + 0.001) throw new HttpError(400, `დაბრუნებული თანხა ვერ იქნება ${refundable} ₾-ზე მეტი`);
  // the repairman's commission shrinks by the same percentage of the refunded money
  const back = Math.min(round2((refund.gel * item.commission_pct) / 100), round2(item.commission_gel - before.back));

  transaction(() => {
    insertId(`INSERT INTO returns (sale_item_id, date, quantity, condition, refund_amount, refund_currency, refund_rate, refund_gel,
      commission_back_gel, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, date, quantity, condition, refund.amount, refund.currency, refund.rate, refund.gel, Math.max(back, 0), textIn(body.note)]);
    const lot = getLot(item.lot_id);
    db.prepare(`UPDATE lots SET ${condition === 'good' ? 'good = good' : 'damaged = damaged'} + ? WHERE id = ?`).run(quantity, lot.id);
    addEvent(lot.id, date, 'returned', condition === 'good' ? quantity : 0, condition === 'good' ? 0 : quantity, textIn(body.note));
  });
  return { ok: true };
});
