import { db } from '../db.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const round2 = (n) => Math.round(n * 100) / 100;

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- input validation ----------

export function posInt(value, label) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label}: მიუთითეთ მთელი დადებითი რიცხვი`);
  return n;
}

export function nonNegInt(value, label) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isInteger(n) || n < 0) throw new HttpError(400, `${label}: მიუთითეთ მთელი რიცხვი (0 ან მეტი)`);
  return n;
}

export function amountIn(value, label) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isFinite(n) || n < 0) throw new HttpError(400, `${label}: მიუთითეთ სწორი თანხა`);
  return round2(n);
}

// currency of an amount: lari, or dollars with the exchange rate (lari for 1 dollar)
export function currencyIn(currency, rate, label) {
  if (currency !== 'USD') return { currency: 'GEL', rate: null };
  const r = Number(rate);
  if (rate === '' || rate == null || !Number.isFinite(r) || r <= 0) throw new HttpError(400, `${label}: მიუთითეთ დოლარის კურსი (1$ = ? ₾)`);
  return { currency: 'USD', rate: Math.round(r * 10000) / 10000 };
}

// {amount, currency, rate} as sent by the page -> amount as entered + its value in lari
export function moneyIn(input, label, { positive = false } = {}) {
  const amount = amountIn(input?.amount, label);
  if (positive && amount === 0) throw new HttpError(400, `${label}: თანხა უნდა იყოს 0-ზე მეტი`);
  const { currency, rate } = currencyIn(input?.currency, input?.rate, label);
  return { amount, currency, rate, gel: toGel(amount, rate) };
}

export const toGel = (amount, rate) => round2(amount * (rate ?? 1));

export function pctIn(value, label = 'საკომისიო') {
  if (value === '' || value == null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, `${label}: პროცენტი უნდა იყოს 0-დან 100-მდე`);
  return round2(n);
}

export function dateIn(value) {
  if (value === '' || value == null) return today();
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, 'არასწორი თარიღი');
  return s;
}

export const textIn = (value) => String(value ?? '').trim();

export function cleanName(value, label = 'დასახელება') {
  const name = textIn(value);
  if (!name) throw new HttpError(400, `მიუთითეთ ${label}`);
  return name;
}

// ---------- database helpers ----------

// all-or-nothing; savepoints so it also works inside an outer transaction (seed.js)
let depth = 0;
export function transaction(fn) {
  const name = `sp${depth++}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  } finally {
    depth--;
  }
}

// run a write; a UNIQUE violation becomes a friendly 409
export function run(sql, params, duplicateMessage) {
  try {
    return db.prepare(sql).run(...params);
  } catch (err) {
    if (duplicateMessage && String(err.message).includes('UNIQUE')) throw new HttpError(409, duplicateMessage);
    throw err;
  }
}

export const insertId = (sql, params, duplicateMessage) => Number(run(sql, params, duplicateMessage).lastInsertRowid);

export function must(row, message = 'ვერ მოიძებნა') {
  if (!row) throw new HttpError(404, message);
  return row;
}

export const getCategory = (id) => must(db.prepare('SELECT * FROM categories WHERE id = ?').get(id), 'კატეგორია ვერ მოიძებნა');
export const getField = (id) => must(db.prepare('SELECT * FROM fields WHERE id = ?').get(id), 'ველი ვერ მოიძებნა');
export const getOption = (id) => must(db.prepare('SELECT * FROM field_options WHERE id = ?').get(id), 'მნიშვნელობა ვერ მოიძებნა');
export const getPart = (id) => must(db.prepare('SELECT * FROM parts WHERE id = ?').get(id), 'ნაწილი ვერ მოიძებნა');
export const getContainer = (id) => must(db.prepare('SELECT * FROM containers WHERE id = ?').get(id), 'კონტეინერი ვერ მოიძებნა');
export const getLot = (id) => must(db.prepare('SELECT * FROM lots WHERE id = ?').get(id), 'ნაწილი კონტეინერში ვერ მოიძებნა');
export const getReferrer = (id) => must(db.prepare('SELECT * FROM referrers WHERE id = ?').get(id), 'ხელოსანი ვერ მოიძებნა');

// Turn what the page sent ({fieldId: {option_id} | {new_value}}) into one option per field
// of the category, creating new options on the fly. Every field must be filled in.
export function resolveValues(categoryId, input) {
  const fields = db.prepare('SELECT id, name FROM fields WHERE category_id = ? ORDER BY id').all(categoryId);
  const chosen = fields.map((field) => {
    const v = input?.[field.id] ?? {};
    const newValue = textIn(v.new_value);
    let optionId;
    if (newValue) {
      const found = db.prepare('SELECT id FROM field_options WHERE field_id = ? AND value = ?').get(field.id, newValue);
      optionId = found ? found.id : insertId('INSERT INTO field_options (field_id, value) VALUES (?, ?)', [field.id, newValue]);
    } else if (v.option_id) {
      const found = db.prepare('SELECT id FROM field_options WHERE id = ? AND field_id = ?').get(Number(v.option_id), field.id);
      if (!found) throw new HttpError(400, `${field.name}: არასწორი მნიშვნელობა`);
      optionId = found.id;
    } else {
      throw new HttpError(400, `მიუთითეთ: ${field.name}`);
    }
    return { fieldId: field.id, optionId };
  });
  return { chosen, signature: chosen.map((c) => `${c.fieldId}:${c.optionId}`).join(',') };
}

// the variant with these values, created if it doesn't exist yet
export function findOrCreatePart(categoryId, values) {
  const { chosen, signature } = resolveValues(categoryId, values);
  const existing = db.prepare('SELECT id FROM parts WHERE category_id = ? AND signature = ?').get(categoryId, signature);
  if (existing) return existing.id;
  const id = insertId('INSERT INTO parts (category_id, signature) VALUES (?, ?)', [categoryId, signature]);
  for (const c of chosen)
    db.prepare('INSERT INTO part_values (part_id, field_id, option_id) VALUES (?, ?, ?)').run(id, c.fieldId, c.optionId);
  return id;
}

// part id -> { category, details: 'Bilstein · Camry 2.5', label: 'ამორტიზატორი — Bilstein · Camry 2.5' }
export function partInfo() {
  const info = new Map();
  for (const p of db.prepare('SELECT p.id, c.name FROM parts p JOIN categories c ON c.id = p.category_id').all())
    info.set(p.id, { category: p.name, values: [] });
  for (const v of db.prepare(`SELECT pv.part_id, o.value FROM part_values pv
      JOIN field_options o ON o.id = pv.option_id ORDER BY pv.part_id, pv.field_id`).all())
    info.get(v.part_id)?.values.push(v.value);
  for (const p of info.values()) {
    p.details = p.values.join(' · ');
    p.label = p.details ? `${p.category} — ${p.details}` : p.category;
    delete p.values;
  }
  return info;
}

export const month = (date) => date.slice(0, 7);
