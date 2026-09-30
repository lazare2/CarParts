const MONTHS = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი',
  'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];

const $ = (sel) => document.querySelector(sel);
let catalog = [];              // categories, each with its fields (+options) and parts (variants)
const openMain = new Set();    // categories expanded on the ნაწილები tab
const openAdmin = new Set();   // category cards expanded on the admin tab
let variantCategory = null;    // category selected in the "add variant" form

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gel = (n) => `${n.toLocaleString('ka-GE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ₾`;
const monthLabel = (m) => { const [y, mo] = m.split('-'); return `${MONTHS[Number(mo) - 1]} ${y}`; };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'შეცდომა');
  return data;
}

let messageTimer;
function showMessage(text, ok = true) {
  const el = $('#message');
  el.textContent = text;
  el.className = `message ${ok ? 'ok' : 'err'}`;
  el.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (el.hidden = true), 4000);
}

// run an action, show the result, refresh data. okText can be a function of the result.
async function act(fn, okText) {
  try {
    const result = await fn();
    const text = typeof okText === 'function' ? okText(result) : okText;
    await refresh();
    if (text) showMessage(text);
    return result;
  } catch (err) {
    showMessage(err.message, false);
    return null;
  }
}

// ---------- catalog helpers ----------

const findCat = (id) => catalog.find((c) => c.id === Number(id));
const findPart = (id) => {
  for (const cat of catalog) {
    const part = cat.parts.find((p) => p.id === Number(id));
    if (part) return { cat, part };
  }
};
const optionText = (field, optionId) => field.options.find((o) => o.id === optionId)?.value ?? '';
const partCells = (cat, part) => cat.fields.map((f) => optionText(f, part.values[f.id]));
const partDetails = (cat, part) => partCells(cat, part).filter(Boolean).join(' · ');
const partLabel = (cat, part) => {
  const d = partDetails(cat, part);
  return d ? `${cat.name} — ${d}` : cat.name;
};
const byText = (a, b) => a.localeCompare(b, 'ka');

// dropdown for every field of a category, plus a box to type a brand-new value
function pickers(cat, current = {}) {
  return cat.fields.map((f) => `
    <div class="picker" data-field="${f.id}">
      <label>${esc(f.name)}
        <select class="pick">
          <option value="">— აირჩიეთ —</option>
          ${f.options.map((o) => `<option value="${o.id}" ${current[f.id] === o.id ? 'selected' : ''}>${esc(o.value)}</option>`).join('')}
        </select>
      </label>
      <input class="pick-new" placeholder="ან ახალი მნიშვნელობა">
    </div>`).join('');
}

function collectValues(root) {
  const values = {};
  root.querySelectorAll('.picker').forEach((p) => {
    const newValue = p.querySelector('.pick-new').value.trim();
    const option = p.querySelector('.pick').value;
    values[p.dataset.field] = newValue ? { new_value: newValue } : option ? { option_id: Number(option) } : {};
  });
  return values;
}

// generic popup form. onSubmit returns a success message, or throws to show an error inside the popup.
function openDialog({ title, body, submit, onSubmit }) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <form method="dialog">
      <h3>${title}</h3>
      ${body}
      <p class="dlg-error" hidden></p>
      <div class="actions">
        <button type="button" class="secondary" data-cancel>გაუქმება</button>
        <button type="submit">${submit}</button>
      </div>
    </form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  const errEl = dlg.querySelector('.dlg-error');
  dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const text = await onSubmit(form);
      dlg.close();
      await refresh();
      if (text) showMessage(text);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
  dlg.showModal();
  return form;
}

// ---------- tabs ----------

document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== btn.dataset.tab));
    if (btn.dataset.tab === 'finance') loadFinance();
  }));

// ---------- ნაწილები ----------

function renderParts() {
  const q = $('#search').value.trim().toLowerCase();
  let html = '';
  let hasParts = false;

  for (const cat of catalog) {
    if (!cat.parts.length) continue;
    hasParts = true;
    const catMatches = cat.name.toLowerCase().includes(q);
    const rows = cat.parts
      .map((part) => ({ part, cells: partCells(cat, part) }))
      .filter((r) => !q || catMatches || r.cells.some((c) => c.toLowerCase().includes(q)))
      .sort((a, b) => byText(a.cells.join(' '), b.cells.join(' ')));
    if (!rows.length) continue;

    const total = cat.parts.reduce((sum, p) => sum + p.quantity, 0);
    html += `
      <details class="cat" data-cat="${cat.id}" ${q || openMain.has(cat.id) ? 'open' : ''}>
        <summary><span class="cat-name">${esc(cat.name)}</span><span class="cat-total">სულ: ${total}</span></summary>
        <table>
          <thead><tr>
            ${cat.fields.map((f) => `<th>${esc(f.name)}</th>`).join('')}
            <th class="num">დარჩენილია</th><th></th>
          </tr></thead>
          <tbody>${rows.map(({ part, cells }) => `
            <tr>
              ${cells.map((c) => `<td>${c ? esc(c) : '—'}</td>`).join('')}
              <td class="num ${part.quantity === 0 ? 'zero' : ''}">${part.quantity}</td>
              <td class="num"><button class="sell" data-sell="${part.id}" ${part.quantity === 0 ? 'disabled' : ''}>გაყიდვა</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </details>`;
  }

  $('#parts-list').innerHTML = html;
  $('#parts-empty').hidden = hasParts;
  $('#parts-nomatch').hidden = !hasParts || html !== '';
}

$('#search').addEventListener('input', renderParts);

// remember which categories the user opened (ignored while searching, which opens everything)
$('#parts-list').addEventListener('toggle', (e) => {
  if ($('#search').value.trim()) return;
  const id = Number(e.target.dataset.cat);
  if (e.target.open) openMain.add(id); else openMain.delete(id);
}, true);

$('#parts-list').addEventListener('click', (e) => {
  const id = e.target.dataset.sell;
  if (!id) return;
  const { cat, part } = findPart(id);
  openSellDialog(cat, part);
});

function openSellDialog(cat, part) {
  const form = openDialog({
    title: `${esc(partLabel(cat, part))} <small>(მარაგში: ${part.quantity})</small>`,
    body: `
      <label>რამდენი გაიყიდა
        <input name="quantity" type="number" min="1" max="${part.quantity}" step="1" value="1" required></label>
      <label>რა ჯამურ ფასად გაიყიდა (₾)
        <input name="price" type="number" min="0" step="0.01" required></label>`,
    submit: 'გაყიდვა',
    async onSubmit(f) {
      await api('POST', `/api/parts/${part.id}/sell`, { quantity: f.quantity.value, price: f.price.value });
      return `გაიყიდა: ${partLabel(cat, part)} × ${f.quantity.value}`;
    },
  });
  form.quantity.select();
}

// ---------- ფინანსები ----------

async function loadFinance() {
  const months = await api('GET', '/api/finance');
  $('#finance-empty').hidden = months.length > 0;
  $('#finance-body').innerHTML = months.map((m) => {
    const net = m.sold - m.spent;
    return `
    <div class="month">
      <h2>${monthLabel(m.month)}
        <span class="summary">გაყიდვები: <b>${gel(m.sold)}</b> · შესყიდვები: <b>${gel(m.spent)}</b> ·
          სხვაობა: <b class="${net >= 0 ? 'profit' : 'loss'}">${gel(net)}</b></span>
      </h2>
      ${m.sales.length ? `
      <table>
        <thead><tr><th>თარიღი</th><th>ნაწილი</th><th class="num">რაოდენობა</th><th class="num">გაყიდვის ფასი</th></tr></thead>
        <tbody>${m.sales.map((s) => `
          <tr><td>${s.date.split('-').reverse().join('.')}</td>
          <td>${esc(s.name)}${s.details ? ` <span class="details">${esc(s.details)}</span>` : ''}</td>
          <td class="num">${s.quantity}</td><td class="num">${gel(s.price)}</td></tr>`).join('')}
        </tbody>
      </table>` : '<p class="empty">ამ თვეში გაყიდვა არ ყოფილა.</p>'}
    </div>`;
  }).join('');
}

// ---------- ადმინი: კატეგორიები და ველები ----------

function renderCategories() {
  $('#cat-list').innerHTML = catalog.map((cat) => `
    <details class="card" data-cat="${cat.id}" ${openAdmin.has(cat.id) ? 'open' : ''}>
      <summary>${esc(cat.name)} <small>(ვარიანტები: ${cat.parts.length})</small></summary>
      <div class="card-body">
        <div class="inline">
          <input class="cat-name" value="${esc(cat.name)}">
          <button class="secondary" data-action="cat-rename">სახელის შენახვა</button>
          <button class="danger" data-action="cat-delete">კატეგორიის წაშლა</button>
        </div>

        <h4>ველები</h4>
        ${cat.fields.map((f) => `
          <div class="field" data-field="${f.id}">
            <div class="inline">
              <input class="field-name" value="${esc(f.name)}">
              <button class="secondary" data-action="field-rename">შენახვა</button>
              <button class="danger" data-action="field-delete">წაშლა</button>
            </div>
            <div class="chips">
              ${f.options.map((o) => `
                <span class="chip" data-opt="${o.id}" data-value="${esc(o.value)}">${esc(o.value)}
                  <button class="link" data-action="opt-rename" title="შეცვლა">✎</button><button class="link" data-action="opt-delete" title="წაშლა">×</button>
                </span>`).join('') || '<span class="hint">მნიშვნელობები ჯერ არ არის</span>'}
            </div>
            <div class="inline">
              <input class="opt-new" placeholder="ახალი მნიშვნელობა">
              <button data-action="opt-add">დამატება</button>
            </div>
          </div>`).join('') || '<p class="hint">ამ კატეგორიას ველები არ აქვს — მას ერთი ვარიანტი ექნება.</p>'}

        <div class="inline new-field">
          <input class="field-new" placeholder="ახალი ველი (მაგ. ძრავი)">
          <button data-action="field-add">ველის დამატება</button>
        </div>
      </div>
    </details>`).join('');
}

$('#cat-list').addEventListener('toggle', (e) => {
  const id = Number(e.target.dataset.cat);
  if (e.target.open) openAdmin.add(id); else openAdmin.delete(id);
}, true);

$('#cat-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const catEl = btn.closest('[data-cat]');
  const catId = catEl.dataset.cat;
  const fieldEl = btn.closest('[data-field]');
  const optEl = btn.closest('[data-opt]');
  const cat = findCat(catId);

  switch (btn.dataset.action) {
    case 'cat-rename':
      act(() => api('PATCH', `/api/categories/${catId}`, { name: catEl.querySelector('.cat-name').value }), 'სახელი შეიცვალა');
      break;
    case 'cat-delete':
      if (confirm(`წავშალო კატეგორია „${cat.name}“?`))
        act(() => api('DELETE', `/api/categories/${catId}`), 'კატეგორია წაიშალა');
      break;
    case 'field-add':
      act(() => api('POST', `/api/categories/${catId}/fields`, { name: catEl.querySelector('.field-new').value }), 'ველი დაემატა');
      break;
    case 'field-rename':
      act(() => api('PATCH', `/api/fields/${fieldEl.dataset.field}`, { name: fieldEl.querySelector('.field-name').value }), 'ველის სახელი შეიცვალა');
      break;
    case 'field-delete':
      if (confirm('წავშალო ეს ველი მისი მნიშვნელობებით?'))
        act(() => api('DELETE', `/api/fields/${fieldEl.dataset.field}`), 'ველი წაიშალა');
      break;
    case 'opt-add':
      act(() => api('POST', `/api/fields/${fieldEl.dataset.field}/options`, { value: fieldEl.querySelector('.opt-new').value }), 'მნიშვნელობა დაემატა');
      break;
    case 'opt-rename': {
      const value = prompt('ახალი მნიშვნელობა:', optEl.dataset.value);
      if (value !== null) act(() => api('PATCH', `/api/options/${optEl.dataset.opt}`, { value }), 'მნიშვნელობა შეიცვალა');
      break;
    }
    case 'opt-delete':
      if (confirm(`წავშალო „${optEl.dataset.value}“?`))
        act(() => api('DELETE', `/api/options/${optEl.dataset.opt}`), 'მნიშვნელობა წაიშალა');
      break;
  }
});

$('#new-category').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fields = form.elements.fields.value.split(',').map((s) => s.trim()).filter(Boolean);
  const result = await act(() => api('POST', '/api/categories', { name: form.elements.name.value, fields }), 'კატეგორია დაემატა');
  if (result) {
    openAdmin.add(result.id);
    variantCategory = result.id;
    form.reset();
    renderAdmin();
  }
});

// ---------- ადმინი: არსებული ვარიანტები ----------

function renderVariants() {
  const rows = catalog.flatMap((cat) => cat.parts.map((part) => ({ cat, part, label: partLabel(cat, part) })))
    .sort((a, b) => byText(a.label, b.label));
  $('#admin-empty').hidden = rows.length > 0;
  $('#admin-body').innerHTML = rows.map(({ cat, part }) => `
    <tr data-part="${part.id}">
      <td>${esc(cat.name)}${partDetails(cat, part) ? ` <span class="details">${esc(partDetails(cat, part))}</span>` : ''}</td>
      <td class="num">${part.quantity}</td>
      <td><div class="inline">
        <input class="set-qty" type="number" min="0" step="1" value="${part.quantity}">
        <button class="secondary" data-action="set">შესწორება</button>
      </div></td>
      <td><div class="inline">
        <button data-action="stock">მარაგის შევსება</button>
        ${cat.fields.length ? '<button class="secondary" data-action="edit">ცვლილება</button>' : ''}
      </div></td>
    </tr>`).join('');
}

$('#admin-body').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  const row = e.target.closest('tr');
  const id = row.dataset.part;
  const { cat, part } = findPart(id);

  if (action === 'set')
    act(() => api('POST', `/api/parts/${id}/set-stock`, { quantity: row.querySelector('.set-qty').value }), 'რაოდენობა შესწორდა');
  if (action === 'stock') openAddStockDialog(cat, part);
  if (action === 'edit')
    openDialog({
      title: `${esc(cat.name)} — ვარიანტის შეცვლა`,
      body: `<div class="pickers">${pickers(cat, part.values)}</div>`,
      submit: 'შენახვა',
      async onSubmit(form) {
        await api('PATCH', `/api/parts/${id}`, { values: collectValues(form) });
        return 'ვარიანტი შეიცვალა';
      },
    });
});

function openAddStockDialog(cat, part) {
  const form = openDialog({
    title: `${esc(partLabel(cat, part))} <small>(მარაგში: ${part.quantity})</small>`,
    body: `
      <label>რამდენი დაემატა
        <input name="quantity" type="number" min="1" step="1" required></label>
      <label>ჯამური ღირებულება (₾)
        <input name="cost" type="number" min="0" step="0.01" required></label>`,
    submit: 'მარაგის შევსება',
    async onSubmit(f) {
      await api('POST', `/api/parts/${part.id}/add-stock`, { quantity: f.elements.quantity.value, cost: f.elements.cost.value });
      return `მარაგი გაიზარდა: ${partLabel(cat, part)} + ${f.elements.quantity.value}`;
    },
  });
  form.elements.quantity.focus();
}

// new variant: pick a category, then a value for each of its fields. An existing combination gets the stock added.
$('#new-variant-btn').addEventListener('click', () => {
  if (!catalog.length) {
    showMessage('ჯერ დაამატეთ კატეგორია განყოფილებაში „კატეგორიები და ველები“', false);
    return;
  }
  if (!findCat(variantCategory)) variantCategory = catalog[0].id;
  const form = openDialog({
    title: 'ახალი ვარიანტი',
    body: `
      <label>კატეგორია
        <select name="category">
          ${catalog.map((c) => `<option value="${c.id}" ${c.id === variantCategory ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></label>
      <div class="pickers" data-pickers>${pickers(findCat(variantCategory))}</div>
      <label>რაოდენობა <input name="quantity" type="number" min="0" step="1" value="1"></label>
      <label>ჯამური ღირებულება (₾) <input name="cost" type="number" min="0" step="0.01"></label>
      <p class="hint">თუ ასეთი ვარიანტი უკვე არსებობს, მარაგი მას დაემატება.</p>`,
    submit: 'დამატება',
    async onSubmit(f) {
      const quantity = Number(f.elements.quantity.value || 0);
      const result = await api('POST', '/api/parts', {
        category_id: variantCategory,
        values: collectValues(f.querySelector('[data-pickers]')),
        quantity: f.elements.quantity.value,
        cost: f.elements.cost.value,
      });
      if (!result.merged) return 'ვარიანტი დაემატა';
      return quantity > 0 ? 'ასეთი ვარიანტი უკვე არსებობდა — მარაგი გაიზარდა' : 'ასეთი ვარიანტი უკვე არსებობს';
    },
  });
  form.elements.category.addEventListener('change', (e) => {
    variantCategory = Number(e.target.value);
    form.querySelector('[data-pickers]').innerHTML = pickers(findCat(variantCategory));
  });
});

// ---------- ადმინი: ქვე-გვერდები ----------

document.querySelectorAll('.sub').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sub').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.subpanel').forEach((p) => (p.hidden = p.id !== `sub-${btn.dataset.sub}`));
  }));

// ---------- start ----------

function renderAdmin() {
  renderCategories();
  renderVariants();
}

async function refresh() {
  catalog = await api('GET', '/api/catalog');
  renderParts();
  renderAdmin();
  if (!$('#finance').hidden) loadFinance();
}

refresh().catch((err) => showMessage(err.message, false));
