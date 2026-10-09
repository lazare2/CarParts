// money per month: sales, refunds, repairman commissions, containers bought
import { db } from '../db.js';
import { route } from './router.js';
import { round2, month, partInfo } from './util.js';

route('GET', '/api/finance', () => {
  const info = partInfo();
  const months = new Map();
  const ensure = (m) => {
    if (!months.has(m))
      months.set(m, { month: m, sales: 0, refunds: 0, commissions: 0, containers: 0, paid_referrers: 0, receipts: [], returns: [], arrived: [] });
    return months.get(m);
  };

  const returnedByItem = new Map();
  for (const r of db.prepare('SELECT sale_item_id, SUM(quantity) AS qty, SUM(refund_gel) AS refund FROM returns GROUP BY sale_item_id').all())
    returnedByItem.set(r.sale_item_id, r);

  const receipts = new Map();
  for (const row of db.prepare(`
      SELECT s.id AS sale_id, s.date, s.currency, s.rate, r.name AS referrer, r.id AS referrer_id,
             si.id, si.quantity, si.damaged, si.price_amount, si.price_gel, si.commission_pct, si.commission_gel,
             l.part_id, c.name AS container
      FROM sales s JOIN sale_items si ON si.sale_id = s.id JOIN lots l ON l.id = si.lot_id
      JOIN containers c ON c.id = l.container_id LEFT JOIN referrers r ON r.id = s.referrer_id
      ORDER BY s.date DESC, s.id DESC, si.id`).all()) {
    if (!receipts.has(row.sale_id)) {
      const receipt = {
        id: row.sale_id, date: row.date, currency: row.currency, rate: row.rate,
        referrer: row.referrer, referrer_id: row.referrer_id, total: 0, commission: 0, items: [],
      };
      receipts.set(row.sale_id, receipt);
      ensure(month(row.date)).receipts.push(receipt);
    }
    const receipt = receipts.get(row.sale_id);
    const returned = returnedByItem.get(row.id);
    receipt.items.push({
      id: row.id, label: info.get(row.part_id).label, container: row.container, quantity: row.quantity,
      damaged: !!row.damaged, price_amount: row.price_amount, price_gel: row.price_gel,
      commission_pct: row.commission_pct, commission_gel: row.commission_gel,
      returned_qty: returned?.qty ?? 0, refunded_gel: round2(returned?.refund ?? 0),
    });
    receipt.total = round2(receipt.total + row.price_gel);
    receipt.commission = round2(receipt.commission + row.commission_gel);
    const m = ensure(month(row.date));
    m.sales += row.price_gel;
    m.commissions += row.commission_gel;
  }

  for (const r of db.prepare(`
      SELECT r.date, r.quantity, r.condition, r.refund_gel, r.commission_back_gel, r.note, s.date AS sale_date, l.part_id
      FROM returns r JOIN sale_items si ON si.id = r.sale_item_id JOIN sales s ON s.id = si.sale_id JOIN lots l ON l.id = si.lot_id
      ORDER BY r.date DESC, r.id DESC`).all()) {
    const m = ensure(month(r.date));
    m.refunds += r.refund_gel;
    m.commissions -= r.commission_back_gel;
    m.returns.push({ ...r, label: info.get(r.part_id).label });
  }

  for (const c of db.prepare('SELECT id, name, arrival_date, cost_gel, cost_amount, cost_currency, cost_rate FROM containers ORDER BY arrival_date DESC').all()) {
    const m = ensure(month(c.arrival_date));
    m.containers += c.cost_gel;
    m.arrived.push(c);
  }

  for (const p of db.prepare('SELECT date, amount_gel FROM referrer_payments').all()) ensure(month(p.date)).paid_referrers += p.amount_gel;

  const list = [...months.values()]
    .map((m) => {
      const out = { ...m };
      for (const k of ['sales', 'refunds', 'commissions', 'containers', 'paid_referrers']) out[k] = round2(m[k]);
      out.result = round2(out.sales - out.refunds - out.commissions - out.containers);
      return out;
    })
    .sort((a, b) => b.month.localeCompare(a.month));

  const totals = { sales: 0, refunds: 0, commissions: 0, containers: 0, result: 0 };
  for (const m of list) for (const k of Object.keys(totals)) totals[k] += m[k];
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

  return { months: list, totals };
});
