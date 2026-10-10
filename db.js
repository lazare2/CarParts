import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');

fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'carparts.db'));
db.exec('PRAGMA foreign_keys = ON');

// ---------- schema ----------
//
// category  (ამორტიზატორი)
//   └─ fields   (ბრენდი, მანქანა, ძრავი ...)   defined per category in the admin tab
//        └─ options (Bilstein, Sachs ...)       the allowed values of each field
// part = one variant of a category: one option chosen for every field.
//   `signature` is the chosen options as text, so the same combination can't exist twice.
//
// container = one shipment with one total price.
// lot       = one part (variant) inside one container: how many arrived and how many are
//             left in good / damaged condition. The stock of a part is the sum of its lots.
// sale      = one customer visit (receipt), optionally sent by a repairman (referrer);
//             its sale_items say which lot each part came from, the price and the commission.
// return    = part of a sale item brought back: refund, and the unit goes back to a lot.
//
// Money is always stored in lari (…_gel). When it was entered in dollars the original
// amount, currency and exchange rate are kept next to it.

const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
`);

// Version 1 had parts(id, name, quantity). Turn every old part into its own category with a
// single variant, keeping ids so purchases/sales stay linked.
function migrateFromV1() {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE parts_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES categories(id),
        signature   TEXT    NOT NULL DEFAULT '',
        quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        UNIQUE (category_id, signature)
      )`);
    const insertCategory = db.prepare('INSERT INTO categories (name) VALUES (?)');
    const insertPart = db.prepare('INSERT INTO parts_new (id, category_id, quantity) VALUES (?, ?, ?)');
    for (const old of db.prepare('SELECT id, name, quantity FROM parts ORDER BY id').all())
      insertPart.run(old.id, Number(insertCategory.run(old.name).lastInsertRowid), old.quantity);
    db.exec('DROP TABLE parts');
    db.exec('ALTER TABLE parts_new RENAME TO parts');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('PRAGMA foreign_keys = ON');
}

if (tableExists('parts') && !columnsOf('parts').includes('category_id')) migrateFromV1();

db.exec(`
  CREATE TABLE IF NOT EXISTS fields (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name        TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (category_id, name)
  );

  CREATE TABLE IF NOT EXISTS field_options (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    field_id INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
    value    TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (field_id, value)
  );

  -- (quantity is left over from version 2 and no longer used: stock lives in lots)
  CREATE TABLE IF NOT EXISTS parts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    signature   TEXT    NOT NULL DEFAULT '',
    quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    UNIQUE (category_id, signature)
  );

  CREATE TABLE IF NOT EXISTS part_values (
    part_id   INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    field_id  INTEGER NOT NULL REFERENCES fields(id),
    option_id INTEGER NOT NULL REFERENCES field_options(id),
    PRIMARY KEY (part_id, field_id)
  );
`);

// Version 2 had sales(part_id, quantity, total_price, date) and purchases(...). Move the old
// sales table out of the way before the new one (a receipt) is created; migrateFromV2 below
// turns the old rows into the new structure.
const hasV2Data = tableExists('sales') && columnsOf('sales').includes('part_id');
if (hasV2Data) db.exec('ALTER TABLE sales RENAME TO legacy_sales');

db.exec(`
  CREATE TABLE IF NOT EXISTS containers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    arrival_date  TEXT NOT NULL,
    cost_amount   REAL NOT NULL CHECK (cost_amount >= 0),
    cost_currency TEXT NOT NULL DEFAULT 'GEL' CHECK (cost_currency IN ('GEL', 'USD')),
    cost_rate     REAL,
    cost_gel      REAL NOT NULL CHECK (cost_gel >= 0),
    note          TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS lots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id INTEGER NOT NULL REFERENCES containers(id),
    part_id      INTEGER NOT NULL REFERENCES parts(id),
    received     INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0),
    good         INTEGER NOT NULL DEFAULT 0 CHECK (good >= 0),
    damaged      INTEGER NOT NULL DEFAULT 0 CHECK (damaged >= 0),
    UNIQUE (container_id, part_id)
  );
  CREATE INDEX IF NOT EXISTS lots_part ON lots(part_id);

  -- history of what happened to the units of a lot (arrival, damage, corrections, returns)
  CREATE TABLE IF NOT EXISTS lot_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    lot_id         INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
    date           TEXT    NOT NULL,
    type           TEXT    NOT NULL CHECK (type IN ('received', 'damaged', 'correction', 'returned')),
    good_change    INTEGER NOT NULL DEFAULT 0,
    damaged_change INTEGER NOT NULL DEFAULT 0,
    note           TEXT    NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS lot_events_lot ON lot_events(lot_id);

  CREATE TABLE IF NOT EXISTS referrers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone       TEXT NOT NULL DEFAULT '',
    default_pct REAL CHECK (default_pct IS NULL OR (default_pct >= 0 AND default_pct <= 100)),
    note        TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS referrer_payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL REFERENCES referrers(id),
    date        TEXT NOT NULL,
    amount      REAL NOT NULL CHECK (amount > 0),
    currency    TEXT NOT NULL DEFAULT 'GEL' CHECK (currency IN ('GEL', 'USD')),
    rate        REAL,
    amount_gel  REAL NOT NULL CHECK (amount_gel > 0),
    note        TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS referrer_payments_referrer ON referrer_payments(referrer_id);

  CREATE TABLE IF NOT EXISTS sales (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    referrer_id INTEGER REFERENCES referrers(id),
    currency    TEXT NOT NULL DEFAULT 'GEL' CHECK (currency IN ('GEL', 'USD')),
    rate        REAL,
    note        TEXT NOT NULL DEFAULT '',
    exchange_id INTEGER REFERENCES exchanges(id)   -- the new parts taken in an exchange
  );
  CREATE INDEX IF NOT EXISTS sales_date ON sales(date);
  CREATE INDEX IF NOT EXISTS sales_referrer ON sales(referrer_id);

  CREATE TABLE IF NOT EXISTS sale_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id        INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    lot_id         INTEGER NOT NULL REFERENCES lots(id),
    quantity       INTEGER NOT NULL CHECK (quantity > 0),
    damaged        INTEGER NOT NULL DEFAULT 0 CHECK (damaged IN (0, 1)),
    price_amount   REAL    NOT NULL CHECK (price_amount >= 0),
    price_gel      REAL    NOT NULL CHECK (price_gel >= 0),
    commission_pct REAL    NOT NULL DEFAULT 0 CHECK (commission_pct >= 0 AND commission_pct <= 100),
    commission_gel REAL    NOT NULL DEFAULT 0 CHECK (commission_gel >= 0)
  );
  CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items(sale_id);
  CREATE INDEX IF NOT EXISTS sale_items_lot ON sale_items(lot_id);

  -- one visit where a customer brought parts back (and maybe took others instead)
  CREATE TABLE IF NOT EXISTS exchanges (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    date                 TEXT NOT NULL,
    sale_id              INTEGER REFERENCES sales(id),          -- the original order, if known
    referrer_id          INTEGER REFERENCES referrers(id),
    responsible          TEXT NOT NULL DEFAULT '' CHECK (responsible IN ('', 'us', 'referrer', 'customer')),
    currency             TEXT NOT NULL DEFAULT 'GEL' CHECK (currency IN ('GEL', 'USD')),
    rate                 REAL,
    credit_gel           REAL NOT NULL DEFAULT 0,               -- value of the parts brought back
    new_gel              REAL NOT NULL DEFAULT 0,               -- value of the parts taken instead
    cash_gel             REAL NOT NULL DEFAULT 0,               -- new - credit: + customer paid us, - we paid the customer
    commission_pct       REAL NOT NULL DEFAULT 0,
    commission_delta_gel REAL NOT NULL DEFAULT 0,               -- how the repairman's commission would change
    commission_applied   INTEGER NOT NULL DEFAULT 0 CHECK (commission_applied IN (0, 1)),
    note                 TEXT NOT NULL DEFAULT '',
    owed_before_gel      REAL,                                  -- what we owed the repairman just before
    commission_amount_gel REAL,                                 -- the agreed change (signed), default = delta
    commission_changed_at TEXT                                  -- when the commission decision was last made
  );

  -- every later change of a return's commission decision
  CREATE TABLE IF NOT EXISTS exchange_commission_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id INTEGER NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    old_applied INTEGER NOT NULL,
    new_applied INTEGER NOT NULL,
    old_amount  REAL,
    new_amount  REAL,
    note        TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS returns (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id         INTEGER REFERENCES exchanges(id),
    sale_item_id        INTEGER REFERENCES sale_items(id) ON DELETE CASCADE,   -- null when the order is not known
    lot_id              INTEGER NOT NULL REFERENCES lots(id),                  -- where the unit went back to
    referrer_id         INTEGER REFERENCES referrers(id),
    date                TEXT    NOT NULL,
    quantity            INTEGER NOT NULL CHECK (quantity > 0),
    condition           TEXT    NOT NULL CHECK (condition IN ('good', 'damaged')),
    refund_amount       REAL    NOT NULL CHECK (refund_amount >= 0),
    refund_currency     TEXT    NOT NULL DEFAULT 'GEL' CHECK (refund_currency IN ('GEL', 'USD')),
    refund_rate         REAL,
    refund_gel          REAL    NOT NULL CHECK (refund_gel >= 0),
    commission_back_gel REAL    NOT NULL DEFAULT 0 CHECK (commission_back_gel >= 0),
    note                TEXT    NOT NULL DEFAULT ''
  );
`);

// Version 2 stock had no containers: put everything into one container "ძველი მარაგი"
// (old stock) whose price is what was paid for it, and turn every old sale into a receipt.
function migrateFromV2() {
  db.exec('BEGIN');
  try {
    const purchases = tableExists('purchases') ? db.prepare('SELECT part_id, total_cost, date FROM purchases').all() : [];
    const oldSales = db.prepare('SELECT part_id, quantity, total_price, date FROM legacy_sales ORDER BY date, id').all();
    const parts = db.prepare('SELECT id, quantity FROM parts').all();
    const sold = new Map();
    for (const s of oldSales) sold.set(s.part_id, (sold.get(s.part_id) ?? 0) + s.quantity);
    const withStock = parts.filter((p) => p.quantity > 0 || sold.has(p.id));

    if (withStock.length || purchases.length) {
      const dates = [...purchases, ...oldSales].map((r) => r.date).sort();
      const arrival = dates[0] ?? today();
      const cost = Math.round(purchases.reduce((sum, p) => sum + p.total_cost, 0) * 100) / 100;
      const containerId = Number(db.prepare(`INSERT INTO containers (name, arrival_date, cost_amount, cost_currency, cost_gel, note)
        VALUES ('ძველი მარაგი', ?, ?, 'GEL', ?, 'გადმოტანილია პროგრამის წინა ვერსიიდან')`).run(arrival, cost, cost).lastInsertRowid);

      const lotOf = new Map();
      for (const p of withStock) {
        const received = p.quantity + (sold.get(p.id) ?? 0);
        const lotId = Number(db.prepare('INSERT INTO lots (container_id, part_id, received, good, damaged) VALUES (?, ?, ?, ?, 0)')
          .run(containerId, p.id, received, p.quantity).lastInsertRowid);
        db.prepare("INSERT INTO lot_events (lot_id, date, type, good_change) VALUES (?, ?, 'received', ?)").run(lotId, arrival, received);
        lotOf.set(p.id, lotId);
      }
      for (const s of oldSales) {
        const saleId = Number(db.prepare("INSERT INTO sales (date, currency) VALUES (?, 'GEL')").run(s.date).lastInsertRowid);
        db.prepare('INSERT INTO sale_items (sale_id, lot_id, quantity, price_amount, price_gel) VALUES (?, ?, ?, ?, ?)')
          .run(saleId, lotOf.get(s.part_id), s.quantity, s.total_price, s.total_price);
      }
    }
    db.exec('DROP TABLE legacy_sales');
    db.exec('DROP TABLE IF EXISTS purchases');
    db.exec('UPDATE parts SET quantity = 0');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Version 2.1 returns were always tied to a sale item. Now a return also knows its lot and
// repairman directly (so a part can be taken back without knowing the order) and its exchange.
function migrateReturns() {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE returns_new (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        exchange_id         INTEGER REFERENCES exchanges(id),
        sale_item_id        INTEGER REFERENCES sale_items(id) ON DELETE CASCADE,
        lot_id              INTEGER NOT NULL REFERENCES lots(id),
        referrer_id         INTEGER REFERENCES referrers(id),
        date                TEXT    NOT NULL,
        quantity            INTEGER NOT NULL CHECK (quantity > 0),
        condition           TEXT    NOT NULL CHECK (condition IN ('good', 'damaged')),
        refund_amount       REAL    NOT NULL CHECK (refund_amount >= 0),
        refund_currency     TEXT    NOT NULL DEFAULT 'GEL' CHECK (refund_currency IN ('GEL', 'USD')),
        refund_rate         REAL,
        refund_gel          REAL    NOT NULL CHECK (refund_gel >= 0),
        commission_back_gel REAL    NOT NULL DEFAULT 0 CHECK (commission_back_gel >= 0),
        note                TEXT    NOT NULL DEFAULT ''
      );
      INSERT INTO returns_new (id, sale_item_id, lot_id, referrer_id, date, quantity, condition, refund_amount,
                               refund_currency, refund_rate, refund_gel, commission_back_gel, note)
        SELECT r.id, r.sale_item_id, si.lot_id, s.referrer_id, r.date, r.quantity, r.condition, r.refund_amount,
               r.refund_currency, r.refund_rate, r.refund_gel, r.commission_back_gel, r.note
        FROM returns r JOIN sale_items si ON si.id = r.sale_item_id JOIN sales s ON s.id = si.sale_id;
      DROP TABLE returns;
      ALTER TABLE returns_new RENAME TO returns;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('PRAGMA foreign_keys = ON');
}

// corrections of an order line's commission (allowed while it is not paid yet), kept as history
db.exec(`
  CREATE TABLE IF NOT EXISTS commission_edits (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
    date         TEXT NOT NULL,
    old_pct      REAL NOT NULL,
    new_pct      REAL NOT NULL,
    old_gel      REAL NOT NULL,
    new_gel      REAL NOT NULL,
    note         TEXT NOT NULL DEFAULT ''
  );
`);

db.exec('DROP VIEW IF EXISTS lot_stats');
if (!columnsOf('returns').includes('lot_id')) migrateReturns();
for (const [col, type] of [['owed_before_gel', 'REAL'], ['commission_amount_gel', 'REAL'], ['commission_changed_at', 'TEXT']])
  if (!columnsOf('exchanges').includes(col)) db.exec(`ALTER TABLE exchanges ADD COLUMN ${col} ${type}`);
db.exec(`CREATE TABLE IF NOT EXISTS exchange_commission_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, exchange_id INTEGER NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    date TEXT NOT NULL, old_applied INTEGER NOT NULL, new_applied INTEGER NOT NULL, old_amount REAL, new_amount REAL,
    note TEXT NOT NULL DEFAULT '')`);
if (!columnsOf('sales').includes('exchange_id')) db.exec('ALTER TABLE sales ADD COLUMN exchange_id INTEGER REFERENCES exchanges(id)');

db.exec(`
  CREATE INDEX IF NOT EXISTS returns_item ON returns(sale_item_id);
  CREATE INDEX IF NOT EXISTS returns_lot ON returns(lot_id);
  CREATE INDEX IF NOT EXISTS returns_exchange ON returns(exchange_id);

  -- per lot: units sold (minus returned), money in (minus refunds) and commissions (minus give-backs)
  CREATE VIEW lot_stats AS
  SELECT l.id AS lot_id, l.container_id, l.part_id, l.received, l.good, l.damaged,
         COALESCE(s.qty, 0)        - COALESCE(r.qty, 0)    AS sold,
         COALESCE(s.revenue, 0)    - COALESCE(r.refund, 0) AS revenue,
         COALESCE(s.commission, 0) - COALESCE(r.back, 0)   AS commission
  FROM lots l
  LEFT JOIN (SELECT lot_id, SUM(quantity) AS qty, SUM(price_gel) AS revenue, SUM(commission_gel) AS commission
             FROM sale_items GROUP BY lot_id) s ON s.lot_id = l.id
  LEFT JOIN (SELECT lot_id, SUM(quantity) AS qty, SUM(refund_gel) AS refund, SUM(commission_back_gel) AS back
             FROM returns GROUP BY lot_id) r ON r.lot_id = l.id;
`);

if (hasV2Data) migrateFromV2();
else if (tableExists('purchases')) db.exec('DROP TABLE purchases');   // (empty v2 database)

export { db };
