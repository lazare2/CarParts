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
// part = one variant of a category: one option chosen for every field, with its own stock.
//   `signature` is the chosen options as text, so the same combination can't exist twice.

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
`);

// Databases from the first version had parts(id, name, quantity). Turn every old part
// into its own category with a single variant, keeping ids so purchases/sales stay linked.
function migrateOldParts() {
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

const partsColumns = db.prepare('PRAGMA table_info(parts)').all();
if (partsColumns.length && !partsColumns.some((c) => c.name === 'category_id')) migrateOldParts();

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

export { db };
