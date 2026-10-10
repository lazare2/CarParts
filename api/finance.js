// money: an overview for a period (totals, chart, containers, repairmen) and the list of all money movements
import { db } from '../db.js';
import { route } from './router.js';
import { containerStats } from './containers.js';
import { round2, today, month, dateIn, partInfo } from './util.js';

// ?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional = everything)
function period(query) {
  const from = query.from ? dateIn(query.from) : null;
  const to = query.to ? dateIn(query.to) : null;
  return { from, to, inside: (d) => (!from || d >= from) && (!to || d <= to) };
}

const saleItemRows = () => db.prepare(`
  SELECT s.id AS sale_id, s.date, s.referrer_id, s.currency, s.rate, s.note, s.exchange_id, si.id, si.quantity, si.damaged,
         si.price_amount, si.price_gel, si.commission_pct, si.commission_gel, l.part_id, l.container_id
  FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN lots l ON l.id = si.lot_id
  ORDER BY s.date DESC, s.id DESC, si.id`).all();

const returnRows = () => db.prepare(`
  SELECT r.id, r.date, r.quantity, r.condition, r.refund_gel, r.refund_amount, r.refund_currency, r.refund_rate,
         r.commission_back_gel, r.note, r.sale_item_id, r.exchange_id, si.sale_id, s.date AS sale_date, r.referrer_id,
         l.part_id, l.container_id
  FROM returns r JOIN lots l ON l.id = r.lot_id LEFT JOIN sale_items si ON si.id = r.sale_item_id LEFT JOIN sales s ON s.id = si.sale_id
  ORDER BY r.date DESC, r.id DESC`).all();

// continuous list of days or months for the chart
function bucketKeys(from, to, granularity, dates) {
  const sorted = dates.filter(Boolean).sort();
  const start = from ?? sorted[0];
  const end = to ?? [sorted.at(-1), today()].filter(Boolean).sort().at(-1);
  if (!start || !end) return [];
  const keys = [];
  if (granularity === 'day') {
    for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1))
      keys.push(d.toISOString().slice(0, 10));
  } else {
    let [y, m] = start.slice(0, 7).split('-').map(Number);
    const last = end.slice(0, 7);
    for (let key = start.slice(0, 7); key <= last; key = `${y}-${String(m).padStart(2, '0')}`) {
      keys.push(key);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
  return keys;
}

route('GET', '/api/finance/overview', (query) => {
  const p = period(query);
  const granularity = query.granularity === 'day' ? 'day' : 'month';
  const keyOf = (d) => (granularity === 'day' ? d : month(d));
  const items = saleItemRows();
  const returns = returnRows();
  const containers = containerStats();
  const payments = db.prepare('SELECT referrer_id, date, amount_gel FROM referrer_payments').all();

  // ----- totals and chart -----
  const totals = { sales: 0, refunds: 0, commissions: 0, containers: 0, receipts: 0, units: 0, paid_referrers: 0 };
  const buckets = new Map(bucketKeys(p.from, p.to, granularity, [
    ...items.map((i) => i.date), ...returns.map((r) => r.date), ...containers.map((c) => c.arrival_date),
  ]).map((k) => [k, { key: k, sales: 0, refunds: 0, commissions: 0, containers: 0 }]));
  const bucket = (d) => buckets.get(keyOf(d));
  const receipts = new Set();

  for (const i of items.filter((x) => p.inside(x.date))) {
    totals.sales += i.price_gel; totals.commissions += i.commission_gel; totals.units += i.quantity;
    if (!i.exchange_id) receipts.add(i.sale_id);
    const b = bucket(i.date); if (b) { b.sales += i.price_gel; b.commissions += i.commission_gel; }
  }
  for (const r of returns.filter((x) => p.inside(x.date))) {
    totals.refunds += r.refund_gel; totals.commissions -= r.commission_back_gel;
    const b = bucket(r.date); if (b) { b.refunds += r.refund_gel; b.commissions -= r.commission_back_gel; }
  }
  for (const c of containers.filter((x) => p.inside(x.arrival_date))) {
    totals.containers += c.cost_gel;
    const b = bucket(c.arrival_date); if (b) b.containers += c.cost_gel;
  }
  for (const pay of payments.filter((x) => p.inside(x.date))) totals.paid_referrers += pay.amount_gel;
  totals.receipts = receipts.size;
  for (const k of ['sales', 'refunds', 'commissions', 'containers', 'paid_referrers']) totals[k] = round2(totals[k]);
  totals.net = round2(totals.sales - totals.refunds - totals.commissions);
  totals.result = round2(totals.net - totals.containers);

  const chart = [...buckets.values()].map((b) => ({
    key: b.key, net: round2(b.sales - b.refunds - b.commissions), containers: round2(b.containers), sales: round2(b.sales),
  }));

  // ----- containers: whole life + what they brought in this period -----
  const periodIncome = new Map();
  const addIncome = (id, v) => periodIncome.set(id, (periodIncome.get(id) ?? 0) + v);
  for (const i of items.filter((x) => p.inside(x.date))) addIncome(i.container_id, i.price_gel - i.commission_gel);
  for (const r of returns.filter((x) => p.inside(x.date))) addIncome(r.container_id, -(r.refund_gel - r.commission_back_gel));
  const sold = containers.filter((c) => c.revenue > 0);
  const totalRevenue = sold.reduce((s, c) => s + c.revenue, 0);
  const avgMargin = totalRevenue > 0 ? round2((sold.reduce((s, c) => s + c.profit, 0) / totalRevenue) * 100) : null;

  // ----- repairmen in this period, per month -----
  const refs = new Map(db.prepare('SELECT id, name, active FROM referrers ORDER BY name COLLATE NOCASE').all()
    .map((r) => [r.id, { ...r, visits: new Set(), units: 0, sales: 0, commission: 0, paid: 0, months: {} }]));
  const monthOf = (r, d) => (r.months[month(d)] ??= { visits: new Set(), commission: 0, sales: 0 });
  for (const i of items.filter((x) => x.referrer_id && p.inside(x.date))) {
    const r = refs.get(i.referrer_id);
    if (!i.exchange_id) r.visits.add(i.sale_id);
    r.units += i.quantity; r.sales += i.price_gel; r.commission += i.commission_gel;
    const m = monthOf(r, i.date); if (!i.exchange_id) m.visits.add(i.sale_id); m.commission += i.commission_gel; m.sales += i.price_gel;
  }
  for (const x of returns.filter((y) => y.referrer_id && p.inside(y.date))) {
    const r = refs.get(x.referrer_id);
    r.sales -= x.refund_gel; r.commission -= x.commission_back_gel;
    const m = monthOf(r, x.date); m.commission -= x.commission_back_gel; m.sales -= x.refund_gel;
  }
  for (const pay of payments.filter((x) => p.inside(x.date))) refs.get(pay.referrer_id).paid += pay.amount_gel;
  // what is still owed is about all time, not the period
  const owed = new Map();
  for (const i of items.filter((x) => x.referrer_id)) owed.set(i.referrer_id, (owed.get(i.referrer_id) ?? 0) + i.commission_gel);
  for (const x of returns.filter((y) => y.referrer_id)) owed.set(x.referrer_id, (owed.get(x.referrer_id) ?? 0) - x.commission_back_gel);
  for (const pay of payments) owed.set(pay.referrer_id, (owed.get(pay.referrer_id) ?? 0) - pay.amount_gel);

  const referrers = [...refs.values()]
    .map((r) => ({
      id: r.id, name: r.name, active: r.active, visits: r.visits.size, units: r.units,
      sales: round2(r.sales), commission: round2(r.commission), paid: round2(r.paid), owed: round2(owed.get(r.id) ?? 0),
      months: Object.fromEntries(Object.entries(r.months).map(([k, m]) => [k, { visits: m.visits.size, commission: round2(m.commission), sales: round2(m.sales) }])),
    }))
    .filter((r) => r.active || r.visits || r.paid || r.owed);

  return {
    totals,
    granularity,
    chart,
    containers: containers.map((c) => ({ ...c, period_income: round2(periodIncome.get(c.id) ?? 0) })),
    avg_margin: avgMargin,
    referrers,
  };
});

// every money movement in the period, newest first: sales (+), refunds (-), repairman payments (-), containers (-)
route('GET', '/api/finance/ledger', (query) => {
  const p = period(query);
  const info = partInfo();
  const names = new Map(db.prepare('SELECT id, name FROM referrers').all().map((r) => [r.id, r.name]));
  const containerNames = new Map(db.prepare('SELECT id, name FROM containers').all().map((c) => [c.id, c.name]));
  const returnedByItem = new Map();
  for (const r of db.prepare('SELECT sale_item_id, SUM(quantity) AS qty, SUM(refund_gel) AS refund FROM returns GROUP BY sale_item_id').all())
    returnedByItem.set(r.sale_item_id, r);

  const entries = [];
  const sales = new Map();
  for (const i of saleItemRows().filter((x) => p.inside(x.date) && !x.exchange_id)) {
    if (!sales.has(i.sale_id)) {
      const entry = {
        key: `sale-${i.sale_id}`, type: 'sale', date: i.date, sale_id: i.sale_id, amount: 0, commission: 0,
        referrer_id: i.referrer_id, referrer: names.get(i.referrer_id) ?? null, currency: i.currency, rate: i.rate, note: i.note, items: [],
      };
      sales.set(i.sale_id, entry);
      entries.push(entry);
    }
    const entry = sales.get(i.sale_id);
    const returned = returnedByItem.get(i.id);
    entry.items.push({
      id: i.id, label: info.get(i.part_id).label, container_id: i.container_id, container: containerNames.get(i.container_id),
      quantity: i.quantity, damaged: !!i.damaged, price_gel: i.price_gel, price_amount: i.price_amount,
      commission_pct: i.commission_pct, commission_gel: i.commission_gel,
      returned_qty: returned?.qty ?? 0, refunded_gel: round2(returned?.refund ?? 0),
    });
    entry.amount = round2(entry.amount + i.price_gel);
    entry.commission = round2(entry.commission + i.commission_gel);
  }
  for (const r of returnRows().filter((x) => p.inside(x.date) && !x.exchange_id)) {
    entries.push({
      key: `return-${r.id}`, type: 'refund', date: r.date, amount: -r.refund_gel, referrer_id: r.referrer_id,
      referrer: names.get(r.referrer_id) ?? null, container_id: r.container_id, container: containerNames.get(r.container_id),
      label: info.get(r.part_id).label, quantity: r.quantity, condition: r.condition, note: r.note, sale_date: r.sale_date,
      commission_back: r.commission_back_gel, currency: r.refund_currency, original: r.refund_amount, rate: r.refund_rate,
    });
  }
  const lotInfo = new Map(db.prepare('SELECT id, part_id, container_id FROM lots').all().map((l) => [l.id, l]));
  const lotLabel = (lotId) => info.get(lotInfo.get(lotId).part_id).label;
  for (const e of db.prepare('SELECT * FROM exchanges').all().filter((x) => p.inside(x.date))) {
    const back = db.prepare('SELECT lot_id, quantity, condition FROM returns WHERE exchange_id = ?').all(e.id);
    const taken = db.prepare('SELECT si.lot_id, si.quantity FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.exchange_id = ?').all(e.id);
    entries.push({
      key: `exchange-${e.id}`, type: 'exchange', date: e.date, amount: e.cash_gel, exchange_id: e.id,
      referrer_id: e.referrer_id, referrer: names.get(e.referrer_id) ?? null, note: e.note, responsible: e.responsible,
      credit: e.credit_gel, new_value: e.new_gel, commission_delta: e.commission_delta_gel, commission_applied: !!e.commission_applied,
      container_ids: [...new Set([...back, ...taken].map((x) => lotInfo.get(x.lot_id).container_id))],
      returned: back.map((b) => ({ label: lotLabel(b.lot_id), quantity: b.quantity, condition: b.condition })),
      taken: taken.map((t) => ({ label: lotLabel(t.lot_id), quantity: t.quantity })),
    });
  }
  for (const pay of db.prepare('SELECT * FROM referrer_payments').all().filter((x) => p.inside(x.date))) {
    entries.push({
      key: `payment-${pay.id}`, type: 'payment', date: pay.date, amount: -pay.amount_gel, payment_id: pay.id,
      referrer_id: pay.referrer_id, referrer: names.get(pay.referrer_id), note: pay.note,
      currency: pay.currency, original: pay.amount, rate: pay.rate,
    });
  }
  for (const c of db.prepare('SELECT * FROM containers').all().filter((x) => p.inside(x.arrival_date))) {
    entries.push({
      key: `container-${c.id}`, type: 'container', date: c.arrival_date, amount: -c.cost_gel, container_id: c.id,
      label: c.name, note: c.note, currency: c.cost_currency, original: c.cost_amount, rate: c.cost_rate,
    });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
  return entries;
});
