// repairmen who send customers (referrers), their commissions and the payments made to them
import { db } from '../db.js';
import { route } from './router.js';
import {
  HttpError, round2, today, month, run, insertId, cleanName, textIn, dateIn, moneyIn, pctIn, getReferrer, must, partInfo,
} from './util.js';

// Every sale line sent by a repairman earns commission in the month of the sale;
// a return takes back its share in the month of the return.
function commissionEntries(referrerId = null) {
  const filter = referrerId ? 'AND s.referrer_id = ?' : '';
  const params = referrerId ? [referrerId] : [];
  const sales = db.prepare(`
    SELECT s.referrer_id, s.id AS sale_id, si.id AS item_id, s.date, l.part_id, si.quantity, si.damaged,
           si.price_gel AS price, si.commission_pct AS pct, si.commission_gel AS amount, 'sale' AS kind
    FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN lots l ON l.id = si.lot_id
    WHERE s.referrer_id IS NOT NULL ${filter}`).all(...params);
  const returns = db.prepare(`
    SELECT s.referrer_id, s.id AS sale_id, si.id AS item_id, r.date, l.part_id, r.quantity, si.damaged,
           -r.refund_gel AS price, si.commission_pct AS pct, -r.commission_back_gel AS amount, 'return' AS kind
    FROM returns r JOIN sale_items si ON si.id = r.sale_item_id JOIN sales s ON s.id = si.sale_id JOIN lots l ON l.id = si.lot_id
    WHERE s.referrer_id IS NOT NULL ${filter}`).all(...params);
  return [...sales, ...returns];
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
    if (e.kind === 'sale') { t.sales += e.price; t.customers.add(e.sale_id); }
    earned.set(e.referrer_id, t);
  }
  const paid = new Map();
  for (const p of paymentsOf()) paid.set(p.referrer_id, (paid.get(p.referrer_id) ?? 0) + p.amount_gel);

  return db.prepare('SELECT * FROM referrers ORDER BY active DESC, name COLLATE NOCASE').all().map((r) => {
    const t = earned.get(r.id) ?? { total: 0, month: 0, sales: 0, customers: new Set() };
    const p = paid.get(r.id) ?? 0;
    return {
      ...r,
      earned: round2(t.total), earned_month: round2(t.month), sales_total: round2(t.sales), visits: t.customers.size,
      paid: round2(p), owed: round2(t.total - p),
    };
  });
});

route('GET', '/api/referrers/:id', (body, id) => {
  const referrer = getReferrer(id);
  const info = partInfo();
  const months = new Map();
  let earned = 0;
  for (const e of commissionEntries(id)) {
    const m = month(e.date);
    if (!months.has(m)) months.set(m, { month: m, earned: 0, sales: 0, lines: [] });
    const entry = months.get(m);
    entry.earned += e.amount;
    entry.sales += e.price;
    entry.lines.push({ ...e, label: info.get(e.part_id).label, amount: round2(e.amount), price: round2(e.price) });
    earned += e.amount;
  }
  const payments = paymentsOf(id);
  const paid = payments.reduce((sum, p) => sum + p.amount_gel, 0);
  return {
    referrer,
    earned: round2(earned),
    paid: round2(paid),
    owed: round2(earned - paid),
    months: [...months.values()]
      .map((m) => ({
        ...m, earned: round2(m.earned), sales: round2(m.sales),
        lines: m.lines.sort((a, b) => b.date.localeCompare(a.date) || b.item_id - a.item_id),
      }))
      .sort((a, b) => b.month.localeCompare(a.month)),
    payments,
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
