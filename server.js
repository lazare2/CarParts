import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const PORT = process.env.PORT || 3000;

fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'carparts.db'));

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS parts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL UNIQUE,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0)
  );

  -- every time stock is bought / added: how many and the total cost
  CREATE TABLE IF NOT EXISTS purchases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id    INTEGER NOT NULL REFERENCES parts(id),
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    total_cost REAL    NOT NULL CHECK (total_cost >= 0),
    date       TEXT    NOT NULL
  );

  -- every sale: how many and the total price it was sold for
  CREATE TABLE IF NOT EXISTS sales (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id     INTEGER NOT NULL REFERENCES parts(id),
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    total_price REAL    NOT NULL CHECK (total_price >= 0),
    date        TEXT    NOT NULL
  );
`);

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

function cleanName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new HttpError(400, 'მიუთითეთ დასახელება');
  return name;
}

function getPart(id) {
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(id);
  if (!part) throw new HttpError(404, 'ნაწილი ვერ მოიძებნა');
  return part;
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

function isDuplicate(err) {
  return String(err.message).includes('UNIQUE');
}

// ---------- API ----------

const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, regex: new RegExp(`^${pattern.replace(/:id/g, '(\\d+)')}$`), handler });

route('GET', '/api/parts', () =>
  db.prepare('SELECT id, name, quantity FROM parts ORDER BY name COLLATE NOCASE').all());

route('POST', '/api/parts', (body) => {
  const name = cleanName(body.name);
  const quantity = body.quantity === '' || body.quantity == null ? 0 : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) throw new HttpError(400, 'რაოდენობა: მიუთითეთ მთელი რიცხვი');
  const cost = quantity > 0 ? money(body.cost, 'თანხა') : 0;
  return transaction(() => {
    try {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO parts (name, quantity) VALUES (?, ?)')
        .run(name, quantity);
      if (quantity > 0)
        db.prepare('INSERT INTO purchases (part_id, quantity, total_cost, date) VALUES (?, ?, ?, ?)')
          .run(lastInsertRowid, quantity, cost, today());
      return { id: Number(lastInsertRowid) };
    } catch (err) {
      if (isDuplicate(err)) throw new HttpError(409, 'ასეთი ნაწილი უკვე არსებობს');
      throw err;
    }
  });
});

route('PATCH', '/api/parts/:id', (body, id) => {
  getPart(id);
  const name = cleanName(body.name);
  try {
    db.prepare('UPDATE parts SET name = ? WHERE id = ?').run(name, id);
  } catch (err) {
    if (isDuplicate(err)) throw new HttpError(409, 'ასეთი ნაწილი უკვე არსებობს');
    throw err;
  }
  return { ok: true };
});

route('POST', '/api/parts/:id/add-stock', (body, id) => {
  getPart(id);
  const quantity = posInt(body.quantity, 'რაოდენობა');
  const cost = money(body.cost, 'თანხა');
  transaction(() => {
    db.prepare('UPDATE parts SET quantity = quantity + ? WHERE id = ?').run(quantity, id);
    db.prepare('INSERT INTO purchases (part_id, quantity, total_cost, date) VALUES (?, ?, ?, ?)')
      .run(id, quantity, cost, today());
  });
  return { ok: true };
});

// manual correction of the stock number (no money involved)
route('POST', '/api/parts/:id/set-stock', (body, id) => {
  getPart(id);
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) throw new HttpError(400, 'რაოდენობა: მიუთითეთ მთელი რიცხვი');
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
  const sales = db.prepare(`
    SELECT s.id, s.date, s.quantity, s.total_price AS price, p.name,
           substr(s.date, 1, 7) AS month
    FROM sales s JOIN parts p ON p.id = s.part_id
    ORDER BY s.date DESC, s.id DESC`).all();
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
};

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
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
