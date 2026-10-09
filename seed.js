// Fills an EMPTY database with fake demo data (containers, sales, repairmen):  npm run seed
// It goes through the same rules as the app (api/), so the numbers are consistent.
// Refuses to run if any container exists. To start over: stop the app and delete the database file.
import { db } from './db.js';
import { dispatch } from './api/index.js';

if (db.prepare('SELECT COUNT(*) AS n FROM containers').get().n > 0) {
  console.log('ბაზაში უკვე არის კონტეინერები — დემო მონაცემები არ დაემატა.');
  process.exit(1);
}

// each variant: [values in field order, rough value of one unit in ₾]
const DEMO = [
  { name: 'ამორტიზატორი', fields: ['ბრენდი', 'მანქანა'], variants: [
    [['KYB', 'Toyota Camry 2.5'], 180], [['Sachs', 'Hyundai Sonata 2.0'], 200], [['Bilstein', 'BMW 320i'], 320], [['KYB', 'Toyota Prius 1.8'], 170]] },
  { name: 'ბრეკის ხუნდი', fields: ['ბრენდი', 'მანქანა', 'პოზიცია'], variants: [
    [['Brembo', 'Toyota Camry 2.5', 'წინა'], 120], [['Brembo', 'Toyota Camry 2.5', 'უკანა'], 95],
    [['TRW', 'Honda Civic 1.8', 'წინა'], 85], [['Bosch', 'Hyundai Sonata 2.0', 'წინა'], 90]] },
  { name: 'ბრეკის დისკი', fields: ['ბრენდი', 'მანქანა', 'პოზიცია'], variants: [
    [['Brembo', 'Toyota Camry 2.5', 'წინა'], 240], [['ATE', 'BMW 320i', 'წინა'], 300]] },
  { name: 'ფარი', fields: ['მანქანა', 'მხარე'], variants: [
    [['Toyota Camry 2.5', 'მარცხენა'], 450], [['Toyota Camry 2.5', 'მარჯვენა'], 450], [['Honda Civic 1.8', 'მარცხენა'], 380]] },
  { name: 'გენერატორი', fields: ['მანქანა', 'ძრავი'], variants: [
    [['Toyota Camry', '2.5'], 350], [['Hyundai Sonata', '2.0'], 320]] },
  { name: 'სარკე', fields: ['მანქანა', 'მხარე'], variants: [
    [['Toyota Prius', 'მარცხენა'], 160], [['Toyota Prius', 'მარჯვენა'], 160], [['Ford Fusion', 'მარცხენა'], 140]] },
  { name: 'რადიატორი', fields: ['მანქანა'], variants: [[['Toyota Camry 2.5'], 260], [['Hyundai Sonata 2.0'], 240]] },
  { name: 'ბამპერი', fields: ['მანქანა', 'პოზიცია', 'ფერი'], variants: [
    [['Toyota Camry 2018', 'წინა', 'თეთრი'], 520], [['Toyota Camry 2018', 'უკანა', 'შავი'], 480], [['Ford Fusion 2016', 'წინა', 'ვერცხლისფერი'], 450]] },
  { name: 'სტარტერი', fields: ['მანქანა'], variants: [[['Honda Civic 1.8'], 210], [['Nissan Rogue 2.5'], 230]] },
  { name: 'კარი', fields: ['მანქანა', 'პოზიცია', 'ფერი'], variants: [
    [['Toyota Prius 2016', 'წინა მარცხენა', 'თეთრი'], 600], [['Hyundai Sonata 2017', 'უკანა მარჯვენა', 'შავი'], 550]] },
];

const CONTAINERS = [
  { name: 'MSKU 3820415', daysAgo: 85, cost: { amount: 9500, currency: 'USD', rate: 2.71 } },
  { name: 'TCLU 5527103', daysAgo: 50, cost: { amount: 11000, currency: 'USD', rate: 2.69 } },
  { name: 'CMAU 7710342', daysAgo: 12, cost: { amount: 24000, currency: 'GEL' } },
];

const REFERRERS = [
  { name: 'გიორგი — ავტოსერვისი ვაკე', phone: '599 12 34 56', default_pct: 10 },
  { name: 'ლევანი — Tbilisi Motors', phone: '577 98 76 54', default_pct: 7 },
  { name: 'დათო (დიდუბე)', phone: '555 44 33 22', default_pct: '' },
];

// small deterministic random generator so the demo data is the same every time
let seed = 20261009;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const pick = (list) => list[Math.floor(rnd() * list.length)];

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const call = (method, path, body) => dispatch(method, path, body);

db.exec('BEGIN');
try {
  // categories
  for (const c of DEMO) call('POST', '/api/categories', { name: c.name, fields: c.fields });
  const catalog = call('GET', '/api/catalog');
  const catByName = new Map(catalog.categories.map((c) => [c.name, c]));

  // containers and their contents (most parts arrive in one or two containers)
  const unitValue = new Map();
  const containers = CONTAINERS.map((c) => ({
    ...c, date: daysAgo(c.daysAgo),
    id: call('POST', '/api/containers', { name: c.name, arrival_date: daysAgo(c.daysAgo), cost: c.cost }).id,
  }));
  for (const def of DEMO) {
    const cat = catByName.get(def.name);
    for (const [values, unit] of def.variants) {
      const into = containers.filter(() => rnd() < 0.55);
      if (!into.length) into.push(pick(containers));
      for (const c of into) {
        const quantity = int(2, 10);
        const damaged = rnd() < 0.2 ? int(1, Math.min(2, quantity)) : 0;
        const body = {
          category_id: cat.id, quantity, damaged, date: c.date,
          values: Object.fromEntries(cat.fields.map((f, i) => [f.id, { new_value: values[i] }])),
        };
        unitValue.set(call('POST', `/api/containers/${c.id}/items`, body).part_id, unit);
      }
    }
  }

  const referrers = REFERRERS.map((r) => call('POST', '/api/referrers', r).id);

  // sales, day by day: only from containers that had already arrived
  const lotsArrived = (day) => {
    const cat = call('GET', '/api/catalog');
    const arrived = new Set(cat.containers.filter((c) => c.arrival_date <= day).map((c) => c.id));
    return cat.categories.flatMap((c) => c.parts).flatMap((p) => p.lots
      .filter((l) => arrived.has(l.container_id) && l.good > 0)
      .map((l) => ({ ...l, part_id: p.id })));
  };
  for (let ago = 80; ago >= 0; ago--) {
    if (rnd() > 0.55) continue;
    const day = daysAgo(ago);
    const lots = lotsArrived(day);
    if (!lots.length) continue;
    const referrer = rnd() < 0.45 ? pick(referrers) : null;
    const pct = referrer ? pick([5, 7, 10, 10, 12]) : 0;
    const chosen = new Map();
    for (let n = int(1, 3); n > 0; n--) { const l = pick(lots); chosen.set(l.id, l); }
    const items = [...chosen.values()].map((l) => {
      const quantity = Math.min(l.good, rnd() < 0.8 ? 1 : 2);
      return { lot_id: l.id, quantity, price: Math.round(unitValue.get(l.part_id) * quantity * (0.8 + rnd() * 0.5)), commission_pct: pct };
    });
    call('POST', '/api/sales', { date: day, referrer_id: referrer, items });
  }

  // a few damaged discoveries and returns
  for (const l of lotsArrived(daysAgo(0)).slice(0, 3)) call('POST', `/api/lots/${l.id}/damage`, { quantity: 1, date: daysAgo(int(1, 20)), note: 'შემოწმებისას აღმოჩნდა' });
  const soldItems = db.prepare(`SELECT si.id, si.price_gel, si.quantity, s.date FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE s.referrer_id IS NOT NULL ORDER BY si.id LIMIT 3`).all();
  soldItems.forEach((it, i) => call('POST', `/api/sale-items/${it.id}/return`, {
    quantity: 1, condition: i === 1 ? 'good' : 'damaged', date: it.date,
    refund: { amount: Math.round(it.price_gel / it.quantity), currency: 'GEL' }, note: i === 1 ? 'არ მოერგო' : 'მყიდველმა დაზიანებული დააბრუნა',
  }));

  // repairmen are paid for every month before the current one
  const thisMonth = daysAgo(0).slice(0, 7);
  for (const id of referrers) {
    for (const m of call('GET', `/api/referrers/${id}`).months) {
      if (m.month >= thisMonth || m.earned <= 0) continue;
      const [y, mo] = m.month.split('-').map(Number);
      const payDay = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-03`;
      call('POST', `/api/referrers/${id}/payments`, { amount: { amount: m.earned, currency: 'GEL' }, date: payDay, note: `${m.month} საკომისიო` });
    }
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`დაემატა: ${count('containers')} კონტეინერი, ${count('lots')} ნაწილი კონტეინერებში, ${count('sales')} გაყიდვა, ` +
  `${count('referrers')} ხელოსანი, ${count('returns')} დაბრუნება.`);
