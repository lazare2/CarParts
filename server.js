import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const PORT = process.env.PORT || 3000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- helpers ----------

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function posInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${label}: მიუთითეთ მთელი დადებითი რიცხვი`);
  return n;
}

function money(value, label) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n) || n < 0)
    throw new HttpError(400, `${label}: მიუთითეთ სწორი თანხა`);
  return Math.round(n * 100) / 100;
}

function cleanName(value, label = 'დასახელება') {
  const name = String(value ?? '').trim();
  if (!name) throw new HttpError(400, `მიუთითეთ ${label}`);
  return name;
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// run a write; a UNIQUE violation becomes a friendly 409
function run(sql, params, duplicateMessage) {
  try {
    return db.prepare(sql).run(...params);
  } catch (err) {
    if (duplicateMessage && String(err.message).includes('UNIQUE')) throw new HttpError(409, duplicateMessage);
    throw err;
  }
}

function must(row, message = 'ვერ მოიძებნა') {
  if (!row) throw new HttpError(404, message);
  return row;
}

const getCategory = (id) => must(db.prepare('SELECT * FROM categories WHERE id = ?').get(id), 'კატეგორია ვერ მოიძებნა');
const getField = (id) => must(db.prepare('SELECT * FROM fields WHERE id = ?').get(id), 'ველი ვერ მოიძებნა');
const getOption = (id) => must(db.prepare('SELECT * FROM field_options WHERE id = ?').get(id), 'მნიშვნელობა ვერ მოიძებნა');
const getPart = (id) => must(db.prepare('SELECT * FROM parts WHERE id = ?').get(id), 'ნაწილი ვერ მოიძებნა');

// Turn what the page sent ({fieldId: {option_id} | {new_value}}) into one option per field
// of the category, creating new options on the fly. Every field must be filled in.
function resolveValues(categoryId, input) {
  const fields = db.prepare('SELECT id, name FROM fields WHERE category_id = ? ORDER BY id').all(categoryId);
  const chosen = fields.map((field) => {
    const v = input?.[field.id] ?? {};
    const newValue = String(v.new_value ?? '').trim();
    let optionId;
    if (newValue) {
      const found = db.prepare('SELECT id FROM field_options WHERE field_id = ? AND value = ?').get(field.id, newValue);
      optionId = found
        ? found.id
        : Number(run('INSERT INTO field_options (field_id, value) VALUES (?, ?)', [field.id, newValue]).lastInsertRowid);
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

function uniqueNames(list) {
  const seen = new Set();
  const names = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw ?? '').trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names;
}

function addPurchase(partId, quantity, cost) {
  db.prepare('UPDATE parts SET quantity = quantity + ? WHERE id = ?').run(quantity, partId);
  db.prepare('INSERT INTO purchases (part_id, quantity, total_cost, date) VALUES (?, ?, ?, ?)')
    .run(partId, quantity, cost, today());
}

// ---------- API ----------

const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, regex: new RegExp(`^${pattern.replace(/:id/g, '(\\d+)')}$`), handler });

// everything the pages need in one go
route('GET', '/api/catalog', () => {
  const fields = db.prepare('SELECT id, category_id, name FROM fields ORDER BY id').all();
  const options = db.prepare('SELECT id, field_id, value FROM field_options ORDER BY value COLLATE NOCASE').all();
  const parts = db.prepare('SELECT id, category_id, quantity FROM parts ORDER BY id').all();
  const values = db.prepare('SELECT part_id, field_id, option_id FROM part_values').all();

  const valuesByPart = new Map();
  for (const v of values) {
    if (!valuesByPart.has(v.part_id)) valuesByPart.set(v.part_id, {});
    valuesByPart.get(v.part_id)[v.field_id] = v.option_id;
  }

  return db.prepare('SELECT id, name FROM categories ORDER BY name COLLATE NOCASE').all().map((c) => ({
    ...c,
    fields: fields
      .filter((f) => f.category_id === c.id)
      .map((f) => ({ id: f.id, name: f.name, options: options.filter((o) => o.field_id === f.id).map(({ id, value }) => ({ id, value })) })),
    parts: parts
      .filter((p) => p.category_id === c.id)
      .map((p) => ({ id: p.id, quantity: p.quantity, values: valuesByPart.get(p.id) ?? {} })),
  }));
});

// categories
route('POST', '/api/categories', (body) => {
  const name = cleanName(body.name, 'კატეგორიის სახელი');
  const fieldNames = uniqueNames(body.fields);
  return transaction(() => {
    const id = Number(run('INSERT INTO categories (name) VALUES (?)', [name], 'ასეთი კატეგორია უკვე არსებობს').lastInsertRowid);
    for (const f of fieldNames) run('INSERT INTO fields (category_id, name) VALUES (?, ?)', [id, f]);
    return { id };
  });
});

route('PATCH', '/api/categories/:id', (body, id) => {
  getCategory(id);
  run('UPDATE categories SET name = ? WHERE id = ?', [cleanName(body.name, 'კატეგორიის სახელი'), id], 'ასეთი კატეგორია უკვე არსებობს');
  return { ok: true };
});

route('DELETE', '/api/categories/:id', (body, id) => {
  getCategory(id);
  if (db.prepare('SELECT COUNT(*) AS n FROM parts WHERE category_id = ?').get(id).n > 0)
    throw new HttpError(409, 'კატეგორიას ნაწილები აქვს და ვერ წაიშლება');
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  return { ok: true };
});

// fields
route('POST', '/api/categories/:id/fields', (body, id) => {
  getCategory(id);
  const fieldId = Number(run('INSERT INTO fields (category_id, name) VALUES (?, ?)',
    [id, cleanName(body.name, 'ველის სახელი')], 'ასეთი ველი უკვე არსებობს').lastInsertRowid);
  return { id: fieldId };
});

route('PATCH', '/api/fields/:id', (body, id) => {
  getField(id);
  run('UPDATE fields SET name = ? WHERE id = ?', [cleanName(body.name, 'ველის სახელი'), id], 'ასეთი ველი უკვე არსებობს');
  return { ok: true };
});

route('DELETE', '/api/fields/:id', (body, id) => {
  getField(id);
  if (db.prepare('SELECT COUNT(*) AS n FROM part_values WHERE field_id = ?').get(id).n > 0)
    throw new HttpError(409, 'ეს ველი ნაწილებში გამოიყენება და ვერ წაიშლება');
  db.prepare('DELETE FROM fields WHERE id = ?').run(id);
  return { ok: true };
});

// field options (the allowed values, e.g. brands)
route('POST', '/api/fields/:id/options', (body, id) => {
  getField(id);
  const optionId = Number(run('INSERT INTO field_options (field_id, value) VALUES (?, ?)',
    [id, cleanName(body.value, 'მნიშვნელობა')], 'ასეთი მნიშვნელობა უკვე არსებობს').lastInsertRowid);
  return { id: optionId };
});

route('PATCH', '/api/options/:id', (body, id) => {
  getOption(id);
  run('UPDATE field_options SET value = ? WHERE id = ?', [cleanName(body.value, 'მნიშვნელობა'), id], 'ასეთი მნიშვნელობა უკვე არსებობს');
  return { ok: true };
});

route('DELETE', '/api/options/:id', (body, id) => {
  getOption(id);
  if (db.prepare('SELECT COUNT(*) AS n FROM part_values WHERE option_id = ?').get(id).n > 0)
    throw new HttpError(409, 'ეს მნიშვნელობა ნაწილებში გამოიყენება და ვერ წაიშლება');
  db.prepare('DELETE FROM field_options WHERE id = ?').run(id);
  return { ok: true };
});

// parts (variants). If the same combination already exists, the stock is added to it.
route('POST', '/api/parts', (body) => {
  const category = getCategory(Number(body.category_id));
  const quantity = body.quantity === '' || body.quantity == null ? 0 : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) throw new HttpError(400, 'რაოდენობა: მიუთითეთ მთელი რიცხვი');
  const cost = quantity > 0 ? money(body.cost, 'თანხა') : 0;

  return transaction(() => {
    const { chosen, signature } = resolveValues(category.id, body.values);
    const existing = db.prepare('SELECT id FROM parts WHERE category_id = ? AND signature = ?').get(category.id, signature);
    if (existing) {
      if (quantity > 0) addPurchase(existing.id, quantity, cost);
      return { id: existing.id, merged: true };
    }
    const id = Number(run('INSERT INTO parts (category_id, signature, quantity) VALUES (?, ?, 0)', [category.id, signature]).lastInsertRowid);
    for (const c of chosen)
      db.prepare('INSERT INTO part_values (part_id, field_id, option_id) VALUES (?, ?, ?)').run(id, c.fieldId, c.optionId);
    if (quantity > 0) addPurchase(id, quantity, cost);
    return { id, merged: false };
  });
});

// change which options a variant has
route('PATCH', '/api/parts/:id', (body, id) => {
  const part = getPart(id);
  transaction(() => {
    const { chosen, signature } = resolveValues(part.category_id, body.values);
    run('UPDATE parts SET signature = ? WHERE id = ?', [signature, id], 'ასეთი ვარიანტი უკვე არსებობს');
    db.prepare('DELETE FROM part_values WHERE part_id = ?').run(id);
    for (const c of chosen)
      db.prepare('INSERT INTO part_values (part_id, field_id, option_id) VALUES (?, ?, ?)').run(id, c.fieldId, c.optionId);
  });
  return { ok: true };
});

route('POST', '/api/parts/:id/add-stock', (body, id) => {
  getPart(id);
  const quantity = posInt(body.quantity, 'რაოდენობა');
  const cost = money(body.cost, 'თანხა');
  transaction(() => addPurchase(id, quantity, cost));
  return { ok: true };
});

// manual correction of the stock number (no money involved)
route('POST', '/api/parts/:id/set-stock', (body, id) => {
  getPart(id);
  const quantity = Number(body.quantity);
  if (body.quantity === '' || !Number.isInteger(quantity) || quantity < 0)
    throw new HttpError(400, 'რაოდენობა: მიუთითეთ მთელი რიცხვი');
  db.prepare('UPDATE parts SET quantity = ? WHERE id = ?').run(quantity, id);
  return { ok: true };
});

route('POST', '/api/parts/:id/sell', (body, id) => {
  const quantity = posInt(body.quantity, 'რაოდენობა');
  const price = money(body.price, 'გასაყიდი ფასი');
  transaction(() => {
    const part = getPart(id);
    if (quantity > part.quantity) throw new HttpError(400, `მარაგში მხოლოდ ${part.quantity} ცალია`);
    db.prepare('UPDATE parts SET quantity = quantity - ? WHERE id = ?').run(quantity, id);
    db.prepare('INSERT INTO sales (part_id, quantity, total_price, date) VALUES (?, ?, ?, ?)')
      .run(id, quantity, price, today());
  });
  return { ok: true };
});

route('GET', '/api/finance', () => {
  const details = new Map();
  for (const v of db.prepare(`
      SELECT pv.part_id, o.value FROM part_values pv
      JOIN field_options o ON o.id = pv.option_id
      ORDER BY pv.part_id, pv.field_id`).all())
    details.set(v.part_id, [...(details.get(v.part_id) ?? []), v.value]);

  const sales = db.prepare(`
    SELECT s.id, s.part_id, s.date, s.quantity, s.total_price AS price, c.name,
           substr(s.date, 1, 7) AS month
    FROM sales s
    JOIN parts p ON p.id = s.part_id
    JOIN categories c ON c.id = p.category_id
    ORDER BY s.date DESC, s.id DESC`).all()
    .map(({ part_id, ...s }) => ({ ...s, details: (details.get(part_id) ?? []).join(' · ') }));

  const spent = db.prepare(`
    SELECT substr(date, 1, 7) AS month, SUM(total_cost) AS total
    FROM purchases GROUP BY month`).all();
  const spentByMonth = Object.fromEntries(spent.map((r) => [r.month, r.total]));

  const months = new Map();
  const ensure = (month) => {
    if (!months.has(month)) months.set(month, { month, sold: 0, spent: spentByMonth[month] ?? 0, sales: [] });
    return months.get(month);
  };
  for (const s of sales) {
    const m = ensure(s.month);
    m.sold += s.price;
    m.sales.push(s);
  }
  for (const month of Object.keys(spentByMonth)) ensure(month);

  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
});

// ---------- server ----------

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new HttpError(413, 'too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'bad json'));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        const match = r.method === req.method && pathname.match(r.regex);
        if (!match) continue;
        const body = req.method === 'GET' ? {} : await readBody(req);
        return send(res, 200, r.handler(body, ...match.slice(1).map(Number)));
      }
      throw new HttpError(404, 'not found');
    }

    const file = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile())
      throw new HttpError(404, 'not found');
    send(res, 200, fs.readFileSync(file), mime[path.extname(file)] ?? 'application/octet-stream');
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'სერვერის შეცდომა' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CarParts გაშვებულია: http://localhost:${PORT}`);
});
