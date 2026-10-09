// მარაგი და კონტეინერები: containers + all stock, filterable; quantities are only managed here, per container
import {
  $, $$, esc, gel, fmt, dateLabel, today, state, api, act, showMessage, refresh, onRefresh, visible, openDialog,
  findCat, pickers, collectValues, stat, qtyBadge, moneyField, readMoney, moneyLabel, byText,
} from './core.js';
import { addToBasket } from './basket.js';

let containers = [];          // with money numbers (GET /api/containers)
let lots = [];                // every part in every container (GET /api/lots)
const selected = new Set();   // chosen containers; empty = all
let stateFilter = 'all';      // all | instock | damaged | soldout
let groupBy = 'part';         // part | container
let focusPart = null;         // "only this part"
let addCategory = null;
let addFormDirty = false;
let addFormFor = null;        // container the add form was drawn for
let addOpen = true;

const EVENT_NAMES = { received: 'მოვიდა', damaged: 'დაზიანდა', correction: 'შესწორება', returned: 'დაბრუნდა', sold: 'გაიყიდა' };
const progress = (pct) => `<div class="progress"><span style="width:${Math.max(0, Math.min(100, pct ?? 0))}%"></span></div>`;
const profitText = (c) => (c.profit >= 0
  ? `<span class="profit">მოგება: ${gel(c.profit)}</span>`
  : `<span class="loss">ასანაზღაურებელია: ${gel(-c.profit)}</span>`);

export async function showStock() {
  if (!visible('stock')) return;
  [containers, lots] = await Promise.all([api('GET', '/api/containers'), api('GET', '/api/lots')]);
  for (const id of [...selected]) if (!containers.some((c) => c.id === id)) selected.delete(id);
  if (focusPart && !lots.some((l) => l.part_id === focusPart)) focusPart = null;
  renderChips();
  renderSummary();
  renderCategoryFilter();
  renderList();
}
onRefresh(showStock);

// ---------- container chips ----------

function renderChips() {
  const byDate = [...containers].sort((a, b) => a.arrival_date.localeCompare(b.arrival_date) || a.id - b.id);
  $('#container-chips').innerHTML = containers.length ? `
    <span class="seg-label">კონტეინერები:</span>
    <button class="fchip ${selected.size ? '' : 'active'}" data-chip="all">ყველა <small>${containers.length}</small></button>
    ${byDate.map((c) => `
      <button class="fchip ${selected.has(c.id) ? 'active' : ''}" data-chip="${c.id}" title="ჩამოვიდა ${dateLabel(c.arrival_date)}">
        ${esc(c.name)} <small>${c.good} ც.</small></button>`).join('')}
    <span class="hint chip-hint">რამდენიმეს ასარჩევად დააჭირეთ რამდენიმეს</span>` : '';
}

$('#container-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-chip]');
  if (!chip) return;
  if (chip.dataset.chip === 'all') selected.clear();
  else {
    const id = Number(chip.dataset.chip);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
  }
  renderChips();
  renderSummary();
  renderList();
});

// ---------- summary: one container's card, or cards of all chosen ----------

function renderSummary() {
  const box = $('#stock-summary');
  if (!containers.length) {
    box.innerHTML = '<p class="empty">კონტეინერები ჯერ არ არის. დაიწყეთ „+ ახალი კონტეინერი“-თი.</p>';
    addFormFor = null;
    return;
  }
  if (selected.size !== 1) {
    addFormFor = null;
    const list = selected.size ? containers.filter((c) => selected.has(c.id)) : containers;
    box.innerHTML = `<div class="card-grid">${list.map((c) => `
      <article class="ccard" data-open="${c.id}" tabindex="0" title="მხოლოდ ამ კონტეინერის ჩვენება">
        <div class="ccard-head"><b>${esc(c.name)}</b><span class="muted">${dateLabel(c.arrival_date)}</span></div>
        <div>ფასი: <b>${moneyLabel(c.cost_gel, c.cost_amount, c.cost_currency, c.cost_rate)}</b></div>
        ${progress(c.recovered_pct)}
        <div>ამოღებულია: <b>${gel(c.income)}</b>${c.recovered_pct != null ? ` (${fmt(c.recovered_pct)}%)` : ''}</div>
        <div>${profitText(c)}</div>
        <div class="units muted">მოვიდა ${c.received} · გაიყიდა ${c.sold} · მარაგში ${c.good} · დაზიან. ${c.damaged}</div>
      </article>`).join('')}</div>`;
    return;
  }

  const c = containers.find((x) => selected.has(x.id));
  if (addFormFor !== c.id || !$('#cc-card')) {
    box.innerHTML = '<div id="cc-card" class="container-card"></div><details id="cc-add" class="add-box"></details>';
    $('#cc-add').addEventListener('toggle', (e) => { addOpen = e.target.open; });
    addFormDirty = false;
  }
  $('#cc-card').innerHTML = `
    <div class="detail-head">
      <h2>${esc(c.name)}</h2>
      <span class="muted">ჩამოვიდა ${dateLabel(c.arrival_date)}${c.note ? ` · ${esc(c.note)}` : ''}</span>
      <span class="grow"></span>
      <button class="sm secondary" data-action="history">ისტორია</button>
      <button class="sm secondary" data-action="edit">რედაქტირება</button>
      ${c.lines ? '' : '<button class="sm danger" data-action="delete">წაშლა</button>'}
    </div>
    <div class="stats">
      ${stat('კონტეინერის ფასი', moneyLabel(c.cost_gel, c.cost_amount, c.cost_currency, c.cost_rate))}
      ${stat('ამოღებულია (გაყიდვები − საკომისიო)', gel(c.income))}
      ${stat('ანაზღაურებულია', c.recovered_pct != null ? `${fmt(c.recovered_pct)}%` : '—', c.recovered_pct >= 100 ? 'good' : '')}
      ${stat(c.profit >= 0 ? 'მოგება' : 'ასანაზღაურებელია', gel(Math.abs(c.profit)), c.profit >= 0 ? 'good' : 'warn')}
      ${stat('მარჟა (მოგება ÷ გაყიდვები)', c.margin != null ? `${fmt(c.margin)}%` : '—')}
      ${stat('მოვიდა / გაიყიდა', `${c.received} / ${c.sold}`)}
      ${stat('მარაგში', c.good)}
      ${stat('დაზიანებული', c.damaged, c.damaged ? 'bad' : '')}
    </div>
    ${progress(c.recovered_pct)}`;
  if (addFormFor !== c.id || !addFormDirty) renderAddForm(c);
}

$('#stock-summary').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-open]');
  if (card) {
    selected.clear();
    selected.add(Number(card.dataset.open));
    renderChips(); renderSummary(); renderList();
    return;
  }
  const action = e.target.dataset.action;
  const c = containers.find((x) => selected.has(x.id));
  if (!action || !c) return;
  if (action === 'edit') containerDialog(c);
  if (action === 'history') historyDialog(c);
  if (action === 'delete' && confirm(`წავშალო კონტეინერი „${c.name}“?`)) {
    if (await act(() => api('DELETE', `/api/containers/${c.id}`), 'კონტეინერი წაიშალა')) { selected.clear(); showStock(); }
  }
});
$('#stock-summary').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest('[data-open]')) e.target.click();
});

$('#new-container-btn').addEventListener('click', () => containerDialog());

function containerDialog(c = null) {
  openDialog({
    title: c ? 'კონტეინერის რედაქტირება' : 'ახალი კონტეინერი',
    body: `
      <label>კონტეინერის სახელი / ნომერი <input name="name" value="${esc(c?.name ?? '')}" required placeholder="მაგ. MSKU1234567"></label>
      <label>ჩამოსვლის თარიღი <input name="arrival_date" type="date" value="${c?.arrival_date ?? today()}" required></label>
      ${moneyField('cost', 'კონტეინერის სრული ფასი', c ? { amount: c.cost_amount, currency: c.cost_currency, rate: c.cost_rate ?? '' } : {})}
      <label>შენიშვნა <input name="note" value="${esc(c?.note ?? '')}" placeholder="არასავალდებულო"></label>`,
    submit: c ? 'შენახვა' : 'შექმნა',
    async onSubmit(f) {
      const body = { name: f.elements.name.value, arrival_date: f.elements.arrival_date.value, cost: readMoney(f, 'cost'), note: f.elements.note.value };
      if (c) {
        await api('PATCH', `/api/containers/${c.id}`, body);
        return 'კონტეინერი შეინახა';
      }
      const { id } = await api('POST', '/api/containers', body);
      selected.clear();
      selected.add(id);          // show the new container with its "add parts" form open
      addOpen = true;
      return 'კონტეინერი შეიქმნა. ახლა დაამატეთ მასში ნაწილები.';
    },
  });
}

async function historyDialog(c) {
  const { history } = await api('GET', `/api/containers/${c.id}`);
  const changeText = (h) => {
    const part = (n, word) => (n ? `${n > 0 ? '+' : ''}${n} ${word}` : '');
    return [part(h.good_change, 'მარაგი'), part(h.damaged_change, 'დაზიან.'), h.amount != null ? gel(h.amount) : ''].filter(Boolean).join(', ');
  };
  openDialog({
    wide: true,
    title: `${esc(c.name)} — ისტორია`,
    body: history.length ? `<div class="table-wrap history-table"><table>
      <thead><tr><th>თარიღი</th><th>მოვლენა</th><th>ნაწილი</th><th>ცვლილება</th><th>შენიშვნა</th></tr></thead>
      <tbody>${history.map((h) => `
        <tr><td>${dateLabel(h.date)}</td><td>${EVENT_NAMES[h.type] ?? h.type}</td><td>${esc(h.label)}</td>
          <td>${changeText(h)}</td><td>${esc(h.note)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="hint">ჯერ არაფერი მომხდარა.</p>',
    submit: 'დახურვა',
    onSubmit: () => null,
  });
}

// ---------- adding parts to the chosen container ----------

function renderAddForm(c) {
  addFormFor = c.id;
  addFormDirty = false;
  const box = $('#cc-add');
  box.open = addOpen || c.lines === 0;
  if (!state.categories.length) {
    box.innerHTML = `<summary>+ ნაწილის დამატება ამ კონტეინერში</summary>
      <p class="hint">ჯერ შექმენით კატეგორია: <b>ადმინი → კატეგორიები და ველები</b> (მაგ. „ამორტიზატორი“ ველებით „ბრენდი, მანქანა“).</p>`;
    return;
  }
  if (!findCat(addCategory)) addCategory = state.categories[0].id;
  box.innerHTML = `
    <summary>+ ნაწილის დამატება ამ კონტეინერში</summary>
    <form id="add-item-form" class="add-form">
      <div class="add-step">
        <span class="step-no">1</span>
        <div class="step-body">
          <div class="step-title">რა ნაწილია?</div>
          <select name="category" aria-label="კატეგორია">${state.categories.map((cat) => `<option value="${cat.id}" ${cat.id === addCategory ? 'selected' : ''}>${esc(cat.name)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="add-step">
        <span class="step-no">2</span>
        <div class="step-body">
          <div class="step-title">მახასიათებლები <span class="muted">— აირჩიეთ სიიდან ან ჩაწერეთ ახალი</span></div>
          <div class="pickers-grid">${fieldPickers()}</div>
        </div>
      </div>
      <div class="add-step">
        <span class="step-no">3</span>
        <div class="step-body">
          <div class="step-title">რამდენი მოვიდა?</div>
          <div class="qty-row">
            <label>სულ რაოდენობა <input name="quantity" type="number" min="1" step="1" value="1" required></label>
            <label>მათ შორის დაზიანებული <input name="damaged" type="number" min="0" step="1" value="0"></label>
            <button type="submit" class="add-submit">დამატება</button>
          </div>
          <p class="hint">თუ ეს ნაწილი ამ კონტეინერში უკვე არის, რაოდენობა მას დაემატება.</p>
        </div>
      </div>
    </form>`;
  const form = $('#add-item-form');
  form.addEventListener('input', () => { addFormDirty = true; });
  form.elements.category.addEventListener('change', (e) => {
    addCategory = Number(e.target.value);
    $('.pickers-grid', form).innerHTML = fieldPickers();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button[type=submit]', form);
    button.disabled = true;
    try {
      const cat = findCat(addCategory);
      const result = await api('POST', `/api/containers/${c.id}/items`, {
        category_id: addCategory, values: collectValues(form),
        quantity: form.elements.quantity.value, damaged: form.elements.damaged.value || 0,
      });
      addFormDirty = false;
      addFormFor = null;       // redraw the form (new values appear in the dropdowns)
      await refresh();
      showMessage(result.merged ? `${cat.name}: რაოდენობა დაემატა არსებულს` : `დაემატა: ${cat.name}`);
      ($('#add-item-form .pick') ?? $('#add-item-form select'))?.focus();
    } catch (err) {
      showMessage(err.message, false);
    } finally {
      button.disabled = false;
    }
  });
}

function fieldPickers() {
  const cat = findCat(addCategory);
  return cat.fields.length ? pickers(cat) : '<p class="hint">ამ კატეგორიას ველები არ აქვს — უბრალოდ მიუთითეთ რაოდენობა.</p>';
}

// ---------- filters ----------

function renderCategoryFilter() {
  const sel = $('#inv-category');
  const current = sel.value;
  sel.innerHTML = '<option value="">ყველა კატეგორია</option>' +
    state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = state.categories.some((c) => String(c.id) === current) ? current : '';
}

$('#inv-search').addEventListener('input', () => renderList());
$('#inv-category').addEventListener('change', () => renderList());
for (const [id, set] of [['#inv-state', (v) => { stateFilter = v; }], ['#inv-group', (v) => { groupBy = v; }]]) {
  $(id).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    $$('button', $(id)).forEach((b) => b.classList.toggle('active', b === btn));
    set(btn.dataset.value);
    renderList();
  });
}
$('#inv-focus').addEventListener('click', (e) => {
  if (e.target.closest('[data-unfocus]')) { focusPart = null; renderList(); }
});

// ---------- the stock list ----------

function filteredLots() {
  const q = $('#inv-search').value.trim().toLowerCase();
  const category = Number($('#inv-category').value) || null;
  return lots.filter((l) =>
    (!selected.size || selected.has(l.container_id)) &&
    (!category || l.category_id === category) &&
    (!focusPart || l.part_id === focusPart) &&
    (!q || l.label.toLowerCase().includes(q)) &&
    (stateFilter === 'all' || (stateFilter === 'instock' && l.good > 0) || (stateFilter === 'damaged' && l.damaged > 0) ||
      (stateFilter === 'soldout' && l.good === 0 && l.damaged === 0)));
}

const containerById = (id) => containers.find((c) => c.id === id);

function lotRow(l, firstCell) {
  return `
    <tr data-lot="${l.lot_id}">
      <td>${firstCell}</td>
      <td class="num">${l.received}</td>
      <td class="num">${l.sold}</td>
      <td class="num">${qtyBadge(l.good)}</td>
      <td class="num">${l.damaged ? `<span class="qty zero">${l.damaged}</span>` : '0'}</td>
      <td class="num">${gel(l.revenue)}</td>
      <td class="num">${l.avg_price != null ? gel(l.avg_price) : '—'}</td>
      <td><div class="row-actions">
        ${l.good || l.damaged ? '<button class="sm" data-action="basket" title="კალათაში დამატება">+ კალათა</button>' : ''}
        ${l.good ? '<button class="sm secondary" data-action="damage">დაზიანება</button>' : ''}
        <button class="sm secondary" data-action="correct">შესწორება</button>
        ${l.has_sales ? '' : '<button class="sm danger" data-action="remove" title="წაშლა">×</button>'}
      </div></td>
    </tr>`;
}

const sumOf = (list, key) => list.reduce((s, l) => s + l[key], 0);
const groupTotals = (list) => `მარაგში <b>${sumOf(list, 'good')}</b> · დაზ. <b>${sumOf(list, 'damaged')}</b> · გაიყიდა ${sumOf(list, 'sold')} · მოვიდა ${sumOf(list, 'received')}`;

function renderList() {
  const list = filteredLots();
  const focused = focusPart ? lots.find((l) => l.part_id === focusPart) : null;
  $('#inv-focus').hidden = !focused;
  if (focused) {
    $('#inv-focus').innerHTML = `ნაჩვენებია მხოლოდ: <b>${esc(focused.label)}</b>
      <button class="sm secondary" data-unfocus>✕ ყველას ჩვენება</button>`;
  }
  $('#inv-totals').innerHTML = list.length
    ? `${list.length} ჩანაწერი · ${groupTotals(list)} · შემოსავალი ${gel(sumOf(list, 'revenue'))}` : '';

  let body = '';
  const flat = selected.size === 1;
  $('#inv-group').hidden = flat;
  if (flat) {
    body = list.sort((a, b) => byText(a.label, b.label)).map((l) => lotRow(l,
      `<b>${esc(l.category)}</b>${l.details ? `<span class="details">${esc(l.details)}</span>` : ''}
       ${focusPart ? '' : `<button class="link focus-link" data-focus="${l.part_id}" title="ამ ნაწილის ნახვა ყველა კონტეინერში">ყველა კონტეინერში →</button>`}`)).join('');
  } else if (groupBy === 'part') {
    const groups = new Map();
    for (const l of list) (groups.get(l.part_id) ?? groups.set(l.part_id, []).get(l.part_id)).push(l);
    body = [...groups.values()].sort((a, b) => byText(a[0].label, b[0].label)).map((g) => `
      <tr class="group-row"><td colspan="8">
        <div class="group-head">
          <span><b>${esc(g[0].category)}</b>${g[0].details ? ` <span class="muted">— ${esc(g[0].details)}</span>` : ''}</span>
          <span class="group-totals">${groupTotals(g)}</span>
          ${focusPart ? '' : `<button class="link" data-focus="${g[0].part_id}" title="მხოლოდ ამ ნაწილის ჩვენება">მხოლოდ ეს</button>`}
        </div></td></tr>
      ${g.sort((a, b) => containerById(a.container_id).arrival_date.localeCompare(containerById(b.container_id).arrival_date))
        .map((l) => lotRow(l, `<span class="lot-pill">${esc(containerById(l.container_id).name)}</span>`)).join('')}`).join('');
  } else {
    const groups = new Map();
    for (const l of list) (groups.get(l.container_id) ?? groups.set(l.container_id, []).get(l.container_id)).push(l);
    body = [...groups.entries()]
      .sort((a, b) => containerById(a[0]).arrival_date.localeCompare(containerById(b[0]).arrival_date))
      .map(([cid, g]) => `
        <tr class="group-row"><td colspan="8">
          <div class="group-head">
            <span><b>${esc(containerById(cid).name)}</b> <span class="muted">ჩამოვიდა ${dateLabel(containerById(cid).arrival_date)}</span></span>
            <span class="group-totals">${groupTotals(g)}</span>
          </div></td></tr>
        ${g.sort((a, b) => byText(a.label, b.label)).map((l) => lotRow(l,
          `${esc(l.category)}${l.details ? `<span class="details">${esc(l.details)}</span>` : ''}`)).join('')}`).join('');
  }

  $('#inv-list').innerHTML = list.length ? `
    <table class="inv-table">
      <thead><tr><th>${groupBy === 'part' && !flat ? 'კონტეინერი' : 'ნაწილი'}</th><th class="num">მოვიდა</th><th class="num">გაიყიდა</th>
        <th class="num">მარაგში</th><th class="num">დაზიან.</th><th class="num">შემოსავალი</th><th class="num">საშ. ფასი / ც.</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table>` : '';
  $('#inv-empty').hidden = list.length > 0 || !containers.length;
  $('#inv-empty').textContent = lots.length ? 'ამ ფილტრებით ვერაფერი მოიძებნა.' : 'ჯერ ნაწილები არ არის. აირჩიეთ კონტეინერი და დაამატეთ.';
}

$('#inv-list').addEventListener('click', (e) => {
  const focus = e.target.closest('[data-focus]');
  if (focus) {
    focusPart = Number(focus.dataset.focus);
    if (selected.size === 1 && focus.classList.contains('focus-link')) { selected.clear(); renderChips(); renderSummary(); }
    renderList();
    return;
  }
  const action = e.target.dataset.action;
  const tr = e.target.closest('tr[data-lot]');
  if (!action || !tr) return;
  const lot = lots.find((l) => l.lot_id === Number(tr.dataset.lot));
  const container = containerById(lot.container_id);
  const label = `${lot.label} (${container.name})`;
  if (action === 'basket') addToBasket(lot.part_id, { lotId: lot.lot_id, damaged: lot.good === 0 });
  if (action === 'damage') damageDialog(lot, label);
  if (action === 'correct') correctDialog(lot, label);
  if (action === 'remove' && confirm(`წავშალო „${label}“?`)) act(() => api('DELETE', `/api/lots/${lot.lot_id}`), 'წაიშალა');
});

function damageDialog(lot, label) {
  const form = openDialog({
    title: `${esc(label)} — დაზიანებულად მონიშვნა`,
    body: `
      <p class="hint">მონიშნული ერთეულები აღარ გამოჩნდება მარაგში. მათი გაყიდვა მაინც შეიძლება, როგორც დაზიანებულის.</p>
      <label>რამდენი ცალი <input name="quantity" type="number" min="1" max="${lot.good}" step="1" value="1" required></label>
      <label>თარიღი <input name="date" type="date" value="${today()}" required></label>
      <label>შენიშვნა <input name="note" placeholder="მაგ. გატეხილი სამაგრი"></label>`,
    submit: 'მონიშვნა',
    async onSubmit(f) {
      await api('POST', `/api/lots/${lot.lot_id}/damage`, { quantity: f.elements.quantity.value, date: f.elements.date.value, note: f.elements.note.value });
      return 'მონიშნულია დაზიანებულად';
    },
  });
  form.elements.quantity.select();
}

function correctDialog(lot, label) {
  openDialog({
    title: `${esc(label)} — შესწორება`,
    body: `
      <p class="hint">ხელით გასწორება (დათვლის შეცდომა, დაკარგული ნაწილი, ან დაზიანებული, რომელიც რეალურად კარგია). ფულზე გავლენა არ აქვს.</p>
      <label>კონტეინერში მოვიდა <input name="received" type="number" min="0" step="1" value="${lot.received}" required></label>
      <label>მარაგში (კარგი) <input name="good" type="number" min="0" step="1" value="${lot.good}" required></label>
      <label>დაზიანებული <input name="damaged" type="number" min="0" step="1" value="${lot.damaged}" required></label>
      <label>მიზეზი <input name="note" placeholder="არასავალდებულო"></label>`,
    submit: 'შენახვა',
    async onSubmit(f) {
      await api('POST', `/api/lots/${lot.lot_id}/correct`, {
        received: f.elements.received.value, good: f.elements.good.value, damaged: f.elements.damaged.value, note: f.elements.note.value,
      });
      return 'შესწორდა';
    },
  });
}
