// sales (one receipt with several parts), the list of orders, cancelling a sale
import { db } from '../db.js';
import { route } from './router.js';
import {
  HttpError, round2, transaction, insertId, textIn, dateIn, currencyIn, amountIn, pctIn, posInt, toGel,
  getReferrer, getLot, must, partInfo,
} from './util.js';

// take the parts out of stock and add them to a sale. pct(item, label) gives the commission % of a line.
export function addSaleItems(saleId, items, { rate, pct }) {
  const info = partInfo();
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
    const p = pct(item, label);
    db.prepare(`UPDATE lots SET ${damaged ? 'damaged = damaged' : 'good = good'} - ? WHERE id = ?`).run(quantity, lot.id);
    db.prepare(`INSERT INTO sale_items (sale_id, lot_id, quantity, damaged, price_amount, price_gel, commission_pct, commission_gel)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(saleId, lot.id, quantity, damaged, price, priceGel, p, round2((priceGel * p) / 100));
  }
}

route('POST', '/api/sales', (body) => {
  const date = dateIn(body.date);
  const referrerId = body.referrer_id ? Number(body.referrer_id) : null;
  if (referrerId) getReferrer(referrerId);
  const { currency, rate } = currencyIn(body.currency, body.rate, 'გაყიდვა');
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'კალათა ცარიელია');

  return transaction(() => {
    const saleId = insertId('INSERT INTO sales (date, referrer_id, currency, rate, note) VALUES (?, ?, ?, ?, ?)',
      [date, referrerId, currency, rate, textIn(body.note)]);
    addSaleItems(saleId, items, { rate, pct: (item, label) => (referrerId ? pctIn(item.commission_pct, `${label}: საკომისიო`) : 0) });
    return { id: saleId };
  });
});

// every order with its parts and what can still be returned (for the returns page), newest first
route('GET', '/api/sales', () => {
  const info = partInfo();
  const returned = new Map(db.prepare(`SELECT sale_item_id, SUM(quantity) AS qty, SUM(refund_gel) AS refund
    FROM returns WHERE sale_item_id IS NOT NULL GROUP BY sale_item_id`).all().map((r) => [r.sale_item_id, r]));
  const sales = new Map();
  for (const row of db.prepare(`
      SELECT s.id AS sale_id, s.date, s.referrer_id, r.name AS referrer, s.exchange_id, s.note,
             si.id, si.lot_id, si.quantity, si.damaged, si.price_gel, si.commission_pct, si.commission_gel, l.part_id, c.name AS container
      FROM sales s JOIN sale_items si ON si.sale_id = s.id JOIN lots l ON l.id = si.lot_id
      JOIN containers c ON c.id = l.container_id LEFT JOIN referrers r ON r.id = s.referrer_id
      ORDER BY s.date DESC, s.id DESC, si.id`).all()) {
    if (!sales.has(row.sale_id))
      sales.set(row.sale_id, { id: row.sale_id, date: row.date, referrer_id: row.referrer_id, referrer: row.referrer,
        exchange_id: row.exchange_id, note: row.note, total: 0, items: [] });
    const sale = sales.get(row.sale_id);
    const ret = returned.get(row.id);
    sale.items.push({
      id: row.id, lot_id: row.lot_id, part_id: row.part_id, label: info.get(row.part_id).label, container: row.container,
      quantity: row.quantity, damaged: !!row.damaged, price_gel: row.price_gel,
      commission_pct: row.commission_pct, commission_gel: row.commission_gel,
      returned_qty: ret?.qty ?? 0, refunded_gel: round2(ret?.refund ?? 0),
    });
    sale.total = round2(sale.total + row.price_gel);
  }
  return [...sales.values()];
});

// undo a sale entered by mistake: everything goes back to stock
route('DELETE', '/api/sales/:id', (body, id) => {
  const sale = must(db.prepare('SELECT id, exchange_id FROM sales WHERE id = ?').get(id), 'გაყიდვა ვერ მოიძებნა');
  if (sale.exchange_id) throw new HttpError(409, 'ეს გაცვლის ნაწილია. გააუქმეთ მთლიანი გაცვლა „დაბრუნება“ გვერდზე.');
  if (db.prepare('SELECT 1 FROM returns r JOIN sale_items si ON si.id = r.sale_item_id WHERE si.sale_id = ?').get(id))
    throw new HttpError(409, 'ამ გაყიდვაზე უკვე დაფიქსირდა დაბრუნება, ამიტომ ვერ გაუქმდება');
  transaction(() => {
    for (const item of db.prepare('SELECT lot_id, quantity, damaged FROM sale_items WHERE sale_id = ?').all(id))
      db.prepare(`UPDATE lots SET ${item.damaged ? 'damaged = damaged' : 'good = good'} + ? WHERE id = ?`).run(item.quantity, item.lot_id);
    db.prepare('DELETE FROM sales WHERE id = ?').run(id);
  });
  return { ok: true };
});
