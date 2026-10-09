// categories, their fields and allowed values, and the part variants
import { db } from '../db.js';
import { route } from './router.js';
import {
  HttpError, transaction, run, insertId, cleanName, textIn, resolveValues,
  getCategory, getField, getOption, getPart,
} from './util.js';

function uniqueNames(list) {
  const seen = new Set();
  const names = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = textIn(raw);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names;
}

// everything the pages need in one go: catalog with stock per container, containers, repairmen
route('GET', '/api/catalog', () => {
  const fields = db.prepare('SELECT id, category_id, name FROM fields ORDER BY id').all();
  const options = db.prepare('SELECT id, field_id, value FROM field_options ORDER BY value COLLATE NOCASE').all();
  const parts = db.prepare('SELECT id, category_id FROM parts ORDER BY id').all();
  const values = db.prepare('SELECT part_id, field_id, option_id FROM part_values').all();
  const lots = db.prepare(`SELECT l.id, l.part_id, l.container_id, l.received, l.good, l.damaged
    FROM lots l JOIN containers c ON c.id = l.container_id ORDER BY c.arrival_date, c.id`).all();

  const valuesByPart = new Map();
  for (const v of values) {
    if (!valuesByPart.has(v.part_id)) valuesByPart.set(v.part_id, {});
    valuesByPart.get(v.part_id)[v.field_id] = v.option_id;
  }
  const lotsByPart = new Map();
  for (const l of lots) {
    if (!lotsByPart.has(l.part_id)) lotsByPart.set(l.part_id, []);
    lotsByPart.get(l.part_id).push({ id: l.id, container_id: l.container_id, received: l.received, good: l.good, damaged: l.damaged });
  }

  const categories = db.prepare('SELECT id, name FROM categories ORDER BY name COLLATE NOCASE').all().map((c) => ({
    ...c,
    fields: fields
      .filter((f) => f.category_id === c.id)
      .map((f) => ({ id: f.id, name: f.name, options: options.filter((o) => o.field_id === f.id).map(({ id, value }) => ({ id, value })) })),
    parts: parts
      .filter((p) => p.category_id === c.id)
      .map((p) => {
        const partLots = lotsByPart.get(p.id) ?? [];
        return {
          id: p.id,
          values: valuesByPart.get(p.id) ?? {},
          lots: partLots,
          good: partLots.reduce((sum, l) => sum + l.good, 0),
          damaged: partLots.reduce((sum, l) => sum + l.damaged, 0),
        };
      }),
  }));

  return {
    categories,
    containers: db.prepare('SELECT id, name, arrival_date FROM containers ORDER BY arrival_date, id').all(),
    referrers: db.prepare('SELECT id, name, phone, default_pct, active FROM referrers ORDER BY name COLLATE NOCASE').all(),
  };
});

// ---------- categories ----------

route('POST', '/api/categories', (body) => {
  const name = cleanName(body.name, 'კატეგორიის სახელი');
  const fieldNames = uniqueNames(body.fields);
  return transaction(() => {
    const id = insertId('INSERT INTO categories (name) VALUES (?)', [name], 'ასეთი კატეგორია უკვე არსებობს');
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

// ---------- fields ----------

route('POST', '/api/categories/:id/fields', (body, id) => {
  getCategory(id);
  return { id: insertId('INSERT INTO fields (category_id, name) VALUES (?, ?)', [id, cleanName(body.name, 'ველის სახელი')], 'ასეთი ველი უკვე არსებობს') };
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

// ---------- field options (the allowed values, e.g. brands) ----------

route('POST', '/api/fields/:id/options', (body, id) => {
  getField(id);
  return { id: insertId('INSERT INTO field_options (field_id, value) VALUES (?, ?)', [id, cleanName(body.value, 'მნიშვნელობა')], 'ასეთი მნიშვნელობა უკვე არსებობს') };
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

// ---------- part variants (created when a container is filled) ----------

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

route('DELETE', '/api/parts/:id', (body, id) => {
  getPart(id);
  if (db.prepare('SELECT COUNT(*) AS n FROM lots WHERE part_id = ?').get(id).n > 0)
    throw new HttpError(409, 'ეს ნაწილი კონტეინერებშია და ვერ წაიშლება');
  db.prepare('DELETE FROM parts WHERE id = ?').run(id);
  return { ok: true };
});
