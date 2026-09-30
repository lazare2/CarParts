// Fills the database with fake demo data:  npm run seed   (or: node seed.js)
// Refuses to run if any parts already exist. To start over: stop the server and delete data/carparts.db
import { db } from './db.js';

if (db.prepare('SELECT COUNT(*) AS n FROM parts').get().n > 0) {
  console.log('ბაზაში უკვე არის ნაწილები — დემო მონაცემები არ დაემატა.');
  process.exit(1);
}

// each variant: [values in field order, unit cost in ₾]
const DEMO = [
  { name: 'ამორტიზატორი', fields: ['ბრენდი', 'ძრავი'], variants: [
    [['KYB', '2.5'], 95], [['Sachs', '2.0'], 110], [['Bilstein', '2.5'], 165], [['ჰონდა', '1.8'], 130]] },
  { name: 'ბრეკის ხუნდი', fields: ['ბრენდი', 'მანქანა', 'პოზიცია'], variants: [
    [['Brembo', 'Toyota Camry 2.5', 'წინა'], 70], [['Brembo', 'Toyota Camry 2.5', 'უკანა'], 55],
    [['TRW', 'Honda Civic 1.8', 'წინა'], 48], [['Bosch', 'Hyundai Sonata 2.0', 'წინა'], 52]] },
  { name: 'ბრეკის დისკი', fields: ['ბრენდი', 'მანქანა', 'პოზიცია'], variants: [
    [['Brembo', 'Toyota Camry 2.5', 'წინა'], 140], [['ATE', 'BMW 320i', 'წინა'], 175], [['ATE', 'BMW 320i', 'უკანა'], 130]] },
  { name: 'ზეთის ფილტრი', fields: ['ბრენდი', 'ძრავი'], variants: [
    [['Mann', '2.0'], 12], [['Mann', '2.5'], 14], [['Bosch', '1.8'], 11], [['Toyota', '2.5'], 18]] },
  { name: 'ჰაერის ფილტრი', fields: ['ბრენდი', 'მანქანა'], variants: [
    [['Mann', 'Toyota Camry 2.5'], 24], [['Mahle', 'Honda Civic 1.8'], 22], [['Bosch', 'Nissan Rogue 2.5'], 26]] },
  { name: 'სალონის ფილტრი', fields: ['ბრენდი', 'მანქანა'], variants: [
    [['Mann', 'Toyota Prius 1.8'], 18], [['Bosch', 'Hyundai Sonata 2.0'], 16], [['Mann', 'Ford Fusion 2.5'], 17]] },
  { name: 'საწვავის ფილტრი', fields: ['ბრენდი', 'ძრავი'], variants: [
    [['Bosch', '2.0'], 28], [['Mann', '2.5'], 30]] },
  { name: 'სანთელი', fields: ['ბრენდი', 'ძრავი'], variants: [
    [['NGK', '1.8'], 9], [['NGK', '2.5'], 10], [['Denso', '2.0'], 11], [['Bosch', '2.5'], 12]] },
  { name: 'აკუმულატორი', fields: ['ბრენდი', 'ტევადობა'], variants: [
    [['Varta', '60Ah'], 150], [['Varta', '75Ah'], 185], [['Bosch', '70Ah'], 170]] },
  { name: 'ძრავის ზეთი', fields: ['ბრენდი', 'სიბლანტე', 'მოცულობა'], variants: [
    [['Castrol', '5W-30', '4ლ'], 55], [['Castrol', '5W-40', '5ლ'], 68], [['Mobil', '5W-30', '4ლ'], 52], [['Shell', '10W-40', '4ლ'], 44]] },
  { name: 'საქარე მინის საწმენდი', fields: ['ბრენდი', 'ზომა'], variants: [
    [['Bosch', '55სმ'], 14], [['Bosch', '60სმ'], 16], [['Valeo', '50სმ'], 13]] },
  { name: 'რადიატორი', fields: ['ბრენდი', 'მანქანა'], variants: [
    [['Nissens', 'Toyota Camry 2.5'], 210], [['Valeo', 'Hyundai Sonata 2.0'], 195]] },
  { name: 'წყლის ტუმბო', fields: ['ბრენდი', 'მანქანა'], variants: [
    [['Gates', 'Toyota Camry 2.5'], 65], [['SKF', 'Ford Fusion 2.5'], 72], [['Gates', 'Honda Civic 1.8'], 58]] },
  { name: 'ბურთულა სახსარი', fields: ['ბრენდი', 'მანქანა'], variants: [
    [['Lemförder', 'Mercedes E220'], 60], [['Lemförder', 'BMW 320i'], 58], [['555', 'Toyota Camry 2.5'], 24]] },
  { name: 'ჰაბის საკისარი', fields: ['ბრენდი', 'მანქანა', 'პოზიცია'], variants: [
    [['SKF', 'Toyota Camry 2.5', 'წინა'], 85], [['SKF', 'Toyota Camry 2.5', 'უკანა'], 78], [['FAG', 'Honda Civic 1.8', 'წინა'], 80]] },
  { name: 'ფარი', fields: ['მანქანა', 'მხარე'], variants: [
    [['Toyota Camry 2.5', 'მარცხენა'], 260], [['Toyota Camry 2.5', 'მარჯვენა'], 260],
    [['Honda Civic 1.8', 'მარცხენა'], 230], [['Honda Civic 1.8', 'მარჯვენა'], 230]] },
  { name: 'ძრავის ღვედი', fields: ['ბრენდი', 'მანქანა'], variants: [
    [['Gates', 'Nissan Rogue 2.5'], 34], [['Contitech', 'Toyota Prius 1.8'], 29]] },
];

// small deterministic random generator so the demo data is the same every time
let seed = 20260930;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const q = {
  category: db.prepare('SELECT id FROM categories WHERE name = ?'),
  addCategory: db.prepare('INSERT INTO categories (name) VALUES (?)'),
  field: db.prepare('SELECT id FROM fields WHERE category_id = ? AND name = ?'),
  addField: db.prepare('INSERT INTO fields (category_id, name) VALUES (?, ?)'),
  option: db.prepare('SELECT id FROM field_options WHERE field_id = ? AND value = ?'),
  addOption: db.prepare('INSERT INTO field_options (field_id, value) VALUES (?, ?)'),
  addPart: db.prepare('INSERT INTO parts (category_id, signature, quantity) VALUES (?, ?, ?)'),
  addValue: db.prepare('INSERT INTO part_values (part_id, field_id, option_id) VALUES (?, ?, ?)'),
  addPurchase: db.prepare('INSERT INTO purchases (part_id, quantity, total_cost, date) VALUES (?, ?, ?, ?)'),
  addSale: db.prepare('INSERT INTO sales (part_id, quantity, total_price, date) VALUES (?, ?, ?, ?)'),
};

const findOrAdd = (find, add, ...args) => find.get(...args)?.id ?? Number(add.run(...args).lastInsertRowid);

let categories = 0, variants = 0, purchases = 0, sales = 0;

db.exec('BEGIN');
try {
  for (const def of DEMO) {
    const existed = q.category.get(def.name);
    const categoryId = findOrAdd(q.category, q.addCategory, def.name);
    if (!existed) categories++;
    const fieldIds = def.fields.map((name) => findOrAdd(q.field, q.addField, categoryId, name));
    // the category may already have been created by hand: it must have exactly these fields
    const dbFields = db.prepare('SELECT id FROM fields WHERE category_id = ? ORDER BY id').all(categoryId).map((f) => f.id);
    if (dbFields.length !== fieldIds.length) throw new Error(`კატეგორიას „${def.name}“ სხვა ველები აქვს, ვიდრე დემო მონაცემებს`);

    for (const [values, unitCost] of def.variants) {
      const optionIds = values.map((v, i) => findOrAdd(q.option, q.addOption, fieldIds[i], v));
      const signature = fieldIds.map((f, i) => `${f}:${optionIds[i]}`).join(',');
      const partId = Number(q.addPart.run(categoryId, signature, 0).lastInsertRowid);
      fieldIds.forEach((f, i) => q.addValue.run(partId, f, optionIds[i]));
      variants++;

      // first purchase 2-3 months ago, sometimes a second one last month
      const firstQty = int(4, 14);
      q.addPurchase.run(partId, firstQty, Math.round(unitCost * firstQty * (0.95 + rnd() * 0.1)), daysAgo(int(60, 88)));
      purchases++;
      let stock = firstQty;
      if (rnd() < 0.5) {
        const more = int(2, 8);
        q.addPurchase.run(partId, more, Math.round(unitCost * more * (0.95 + rnd() * 0.1)), daysAgo(int(3, 30)));
        purchases++;
        stock += more;
      }

      // a few sales; some variants sell out completely, some run low
      let available = firstQty;
      const sell = (qty) => {
        q.addSale.run(partId, qty, Math.round(unitCost * qty * (1.25 + rnd() * 0.35)), daysAgo(int(0, 55)));
        sales++;
        stock -= qty;
      };
      for (let s = int(0, 3); s > 0 && available > 0; s--) {
        const qty = Math.min(int(1, 3), available);
        sell(qty);
        available -= qty;
      }
      if (rnd() < 0.06 && stock > 0) sell(stock);
      db.prepare('UPDATE parts SET quantity = ? WHERE id = ?').run(stock, partId);
    }
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

console.log(`დაემატა: ${categories} ახალი კატეგორია, ${variants} ვარიანტი, ${purchases} შესყიდვა, ${sales} გაყიდვა.`);
