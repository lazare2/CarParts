// containers (shipments) and the lots of parts inside them
import { db } from '../db.js';
import { route } from './router.js';
import {
  HttpError, round2, transaction, run, insertId, cleanName, textIn, dateIn, moneyIn, posInt, nonNegInt,
  getCategory, getContainer, getLot, findOrCreatePart, partInfo,
} from './util.js';

// cost vs. what came back: income = sales - refunds - repairman commissions
function withMoney(c) {
  const income = round2(c.revenue - c.commission);
  return {
    ...c,
    revenue: round2(c.revenue),
    commission: round2(c.commission),
    income,
    profit: round2(income - c.cost_gel),
    recovered_pct: c.cost_gel > 0 ? round2((income / c.cost_gel) * 100) : null,
  };
}

function containerStats(where = '', params = []) {
  return db.prepare(`
    SELECT c.*, COUNT(ls.lot_id) AS lines,
           COALESCE(SUM(ls.received), 0) AS received, COALESCE(SUM(ls.good), 0) AS good,
           COALESCE(SUM(ls.damaged), 0) AS damaged, COALESCE(SUM(ls.sold), 0) AS sold,
           COALESCE(SUM(ls.revenue), 0) AS revenue, COALESCE(SUM(ls.commission), 0) AS commission
    FROM containers c LEFT JOIN lot_stats ls ON ls.container_id = c.id
    ${where}
    GROUP BY c.id ORDER BY c.arrival_date DESC, c.id DESC`).all(...params).map(withMoney);
}

function addEvent(lotId, date, type, goodChange, damagedChange, note = '') {
  db.prepare('INSERT INTO lot_events (lot_id, date, type, good_change, damaged_change, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(lotId, date, type, goodChange, damagedChange, note);
}
export { addEvent };

function containerInput(body) {
  const cost = moneyIn(body.cost, 'კონტეინერის ფასი');
  return {
    name: cleanName(body.name, 'კონტეინერის სახელი / ნომერი'),
    arrival: dateIn(body.arrival_date),
    cost,
    note: textIn(body.note),
  };
}

route('GET', '/api/containers', () => containerStats());

route('GET', '/api/containers/:id', (body, id) => {
  getContainer(id);
  const container = containerStats('WHERE c.id = ?', [id])[0];
  const info = partInfo();
  const lots = db.prepare(`SELECT ls.*, p.category_id FROM lot_stats ls JOIN parts p ON p.id = ls.part_id
    WHERE ls.container_id = ?`).all(id).map((l) => ({
    ...l,
    revenue: round2(l.revenue),
    commission: round2(l.commission),
    avg_price: l.sold > 0 ? round2(l.revenue / l.sold) : null,
    category: info.get(l.part_id).category,
    details: info.get(l.part_id).details,
    label: info.get(l.part_id).label,
    has_sales: !!db.prepare('SELECT 1 FROM sale_items WHERE lot_id = ?').get(l.lot_id),
  }));
  lots.sort((a, b) => a.label.localeCompare(b.label, 'ka'));

  // what happened in this container, newest first
  const events = db.prepare(`SELECT e.id, e.date, e.type, e.good_change, e.damaged_change, e.note, l.part_id
    FROM lot_events e JOIN lots l ON l.id = e.lot_id WHERE l.container_id = ?`).all(id);
  const sold = db.prepare(`SELECT si.id, s.date, si.quantity, si.damaged, si.price_gel, l.part_id, r.name AS referrer
    FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN lots l ON l.id = si.lot_id
    LEFT JOIN referrers r ON r.id = s.referrer_id WHERE l.container_id = ?`).all(id);
  const history = [
    ...events.map((e) => ({ ...e, key: `e${e.id}`, label: info.get(e.part_id).label })),
    ...sold.map((s) => ({
      key: `s${s.id}`, date: s.date, type: 'sold', label: info.get(s.part_id).label,
      good_change: s.damaged ? 0 : -s.quantity, damaged_change: s.damaged ? -s.quantity : 0,
      amount: s.price_gel, note: s.referrer ? `ხელოსანი: ${s.referrer}` : '',
    })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.key.localeCompare(a.key, 'en', { numeric: true }));

  return { container, lots, history };
});

route('POST', '/api/containers', (body) => {
  const c = containerInput(body);
  return {
    id: insertId(`INSERT INTO containers (name, arrival_date, cost_amount, cost_currency, cost_rate, cost_gel, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [c.name, c.arrival, c.cost.amount, c.cost.currency, c.cost.rate, c.cost.gel, c.note],
    'ასეთი სახელის კონტეინერი უკვე არსებობს'),
  };
});

route('PATCH', '/api/containers/:id', (body, id) => {
  getContainer(id);
  const c = containerInput(body);
  run(`UPDATE containers SET name = ?, arrival_date = ?, cost_amount = ?, cost_currency = ?, cost_rate = ?, cost_gel = ?, note = ?
    WHERE id = ?`, [c.name, c.arrival, c.cost.amount, c.cost.currency, c.cost.rate, c.cost.gel, c.note, id],
  'ასეთი სახელის კონტეინერი უკვე არსებობს');
  return { ok: true };
});

route('DELETE', '/api/containers/:id', (body, id) => {
  getContainer(id);
  if (db.prepare('SELECT COUNT(*) AS n FROM lots WHERE container_id = ?').get(id).n > 0)
    throw new HttpError(409, 'კონტეინერში ნაწილებია. ჯერ ისინი წაშალეთ.');
  db.prepare('DELETE FROM containers WHERE id = ?').run(id);
  return { ok: true };
});

// add parts to a container; the same part twice in one container adds up
route('POST', '/api/containers/:id/items', (body, id) => {
  getContainer(id);
  const category = getCategory(Number(body.category_id));
  const quantity = posInt(body.quantity, 'რაოდენობა');
  const damaged = body.damaged === '' || body.damaged == null ? 0 : nonNegInt(body.damaged, 'დაზიანებული');
  if (damaged > quantity) throw new HttpError(400, 'დაზიანებული ვერ იქნება საერთო რაოდენობაზე მეტი');
  const date = dateIn(body.date);

  return transaction(() => {
    const partId = findOrCreatePart(category.id, body.values);
    const existing = db.prepare('SELECT id FROM lots WHERE container_id = ? AND part_id = ?').get(id, partId);
    const lotId = existing ? existing.id : insertId('INSERT INTO lots (container_id, part_id) VALUES (?, ?)', [id, partId]);
    db.prepare('UPDATE lots SET received = received + ?, good = good + ?, damaged = damaged + ? WHERE id = ?')
      .run(quantity, quantity - damaged, damaged, lotId);
    addEvent(lotId, date, 'received', quantity - damaged, damaged, textIn(body.note));
    return { lot_id: lotId, part_id: partId, merged: !!existing };
  });
});

// ---------- lots ----------

// some good units turned out to be damaged
route('POST', '/api/lots/:id/damage', (body, id) => {
  const quantity = posInt(body.quantity, 'რაოდენობა');
  const date = dateIn(body.date);
  transaction(() => {
    const lot = getLot(id);
    if (quantity > lot.good) throw new HttpError(400, `მარაგში (კარგ მდგომარეობაში) მხოლოდ ${lot.good} ცალია`);
    db.prepare('UPDATE lots SET good = good - ?, damaged = damaged + ? WHERE id = ?').run(quantity, quantity, id);
    addEvent(id, date, 'damaged', -quantity, quantity, textIn(body.note));
  });
  return { ok: true };
});

// fix the numbers by hand (counting mistakes, lost items, a damaged unit that is fine after all)
route('POST', '/api/lots/:id/correct', (body, id) => {
  const received = nonNegInt(body.received, 'მოვიდა');
  const good = nonNegInt(body.good, 'მარაგში');
  const damaged = nonNegInt(body.damaged, 'დაზიანებული');
  transaction(() => {
    const lot = getLot(id);
    db.prepare('UPDATE lots SET received = ?, good = ?, damaged = ? WHERE id = ?').run(received, good, damaged, id);
    const note = [textIn(body.note), received !== lot.received ? `მოვიდა: ${lot.received} → ${received}` : '']
      .filter(Boolean).join('; ');
    if (good !== lot.good || damaged !== lot.damaged || received !== lot.received)
      addEvent(id, dateIn(body.date), 'correction', good - lot.good, damaged - lot.damaged, note);
  });
  return { ok: true };
});

route('DELETE', '/api/lots/:id', (body, id) => {
  getLot(id);
  if (db.prepare('SELECT 1 FROM sale_items WHERE lot_id = ?').get(id))
    throw new HttpError(409, 'ამ ნაწილიდან უკვე გაიყიდა, ამიტომ ვერ წაიშლება. გამოიყენეთ „შესწორება“.');
  db.prepare('DELETE FROM lots WHERE id = ?').run(id);
  return { ok: true };
});
