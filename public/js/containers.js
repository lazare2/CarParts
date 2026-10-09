// კონტეინერები: list of shipments, and one container's page (add parts, damage, profit)
import {
  $, $$, esc, gel, fmt, dateLabel, today, state, api, act, showMessage, refresh, onRefresh, visible, openDialog,
  findCat, pickers, collectValues, stat, qtyBadge, moneyField, readMoney, moneyLabel,
} from './core.js';
import { addToBasket } from './basket.js';

let openId = null;          // container shown in detail, null = the list
let addCategory = null;     // category chosen in the "add parts" form (kept between additions)
let addFormDirty = false;   // the user is typing in the form: don't redraw it on refresh
let lotSearch = '';

const EVENT_NAMES = { received: 'მოვიდა', damaged: 'დაზიანდა', correction: 'შესწორება', returned: 'დაბრუნდა', sold: 'გაიყიდა' };

const progress = (pct) => `<div class="progress"><span style="width:${Math.max(0, Math.min(100, pct ?? 0))}%"></span></div>`;
const profitText = (c) => (c.profit >= 0
  ? `<span class="profit">მოგება: ${gel(c.profit)}</span>`
  : `<span class="loss">ასანაზღაურებელია: ${gel(-c.profit)}</span>`);

export async function showContainers() {
  if (!visible('containers')) return;
  $('#containers-list-view').hidden = !!openId;
  $('#container-detail').hidden = !openId;
  if (openId) await loadDetail(); else await loadList();
}
onRefresh(showContainers);

// ---------- list ----------

async function loadList() {
  const list = await api('GET', '/api/containers');
  $('#containers-empty').hidden = list.length > 0;
  $('#container-cards').innerHTML = list.map((c) => `
    <article class="ccard" data-open="${c.id}" tabindex="0">
      <div class="ccard-head"><b>${esc(c.name)}</b><span class="muted">${dateLabel(c.arrival_date)}</span></div>
      <div>ფასი: <b>${moneyLabel(c.cost_gel, c.cost_amount, c.cost_currency, c.cost_rate)}</b></div>
      ${progress(c.recovered_pct)}
      <div>ამოღებულია: <b>${gel(c.income)}</b>${c.recovered_pct != null ? ` (${fmt(c.recovered_pct)}%)` : ''}</div>
      <div>${profitText(c)}</div>
      <div class="units muted">მოვიდა ${c.received} · გაიყიდა ${c.sold} · მარაგში ${c.good} · დაზიან. ${c.damaged}</div>
    </article>`).join('');
}

$('#container-cards').addEventListener('click', (e) => {
  const card = e.target.closest('[data-open]');
  if (card) openContainer(Number(card.dataset.open));
});
$('#container-cards').addEventListener('keydown', (e) => {
  const card = e.target.closest('[data-open]');
  if (card && e.key === 'Enter') openContainer(Number(card.dataset.open));
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
      openId = id;          // go straight to the new container to add its parts
      addFormDirty = false;
      buildDetailSkeleton();
      return 'კონტეინერი შეიქმნა. ახლა დაამატეთ მასში ნაწილები.';
    },
  });
}

// ---------- detail ----------

export function openContainer(id) {
  openId = id;
  addFormDirty = false;
  lotSearch = '';
  buildDetailSkeleton();
  showContainers();
}

function buildDetailSkeleton() {
  $('#container-detail').innerHTML = `
    <div id="cd-head" class="detail-head"></div>
    <div id="cd-stats" class="stats"></div>
    <section id="cd-add" class="add-box"></section>
    <div class="toolbar"><input id="lot-search" type="search" placeholder="ძებნა ამ კონტეინერში"></div>
    <div id="cd-lines" class="table-wrap"></div>
    <details id="cd-history" class="history"></details>`;
  $('#lot-search').addEventListener('input', (e) => { lotSearch = e.target.value.trim().toLowerCase(); filterLots(); });
  renderAddForm();
}

let detail = null;

async function loadDetail() {
  if (!$('#cd-head')) buildDetailSkeleton();
  try {
    detail = await api('GET', `/api/containers/${openId}`);
  } catch (err) {        // e.g. it was deleted
    openId = null;
    showMessage(err.message, false);
    return showContainers();
  }
  const c = detail.container;
  $('#cd-head').innerHTML = `
    <button class="sm secondary" data-action="back">← ყველა კონტეინერი</button>
    <h2>${esc(c.name)}</h2>
    <span class="muted">ჩამოვიდა ${dateLabel(c.arrival_date)}${c.note ? ` · ${esc(c.note)}` : ''}</span>
    <span class="grow"></span>
    <button class="sm secondary" data-action="edit">რედაქტირება</button>
    ${c.lines ? '' : '<button class="sm danger" data-action="delete">წაშლა</button>'}`;
  $('#cd-stats').innerHTML =
    stat('კონტეინერის ფასი', moneyLabel(c.cost_gel, c.cost_amount, c.cost_currency, c.cost_rate)) +
    stat('ამოღებულია (გაყიდვები − საკომისიო)', gel(c.income)) +
    stat('ანაზღაურებულია', c.recovered_pct != null ? `${fmt(c.recovered_pct)}%` : '—', c.recovered_pct >= 100 ? 'good' : '') +
    stat(c.profit >= 0 ? 'მოგება' : 'ასანაზღაურებელია', gel(Math.abs(c.profit)), c.profit >= 0 ? 'good' : 'warn') +
    stat('მოვიდა / გაიყიდა', `${c.received} / ${c.sold}`) +
    stat('მარაგში', c.good) +
    stat('დაზიანებული', c.damaged, c.damaged ? 'bad' : '');

  $('#cd-lines').innerHTML = detail.lots.length ? `
    <table class="lots-table">
      <thead><tr><th>ნაწილი</th><th class="num">მოვიდა</th><th class="num">გაიყიდა</th><th class="num">მარაგში</th>
        <th class="num">დაზიან.</th><th class="num">შემოსავალი</th><th class="num">საშ. ფასი / ც.</th><th></th></tr></thead>
      <tbody>${detail.lots.map((l) => `
        <tr data-lot="${l.lot_id}" data-part="${l.part_id}" data-search="${esc(l.label.toLowerCase())}">
          <td>${esc(l.category)}${l.details ? `<span class="details">${esc(l.details)}</span>` : ''}</td>
          <td class="num">${l.received}</td>
          <td class="num">${l.sold}</td>
          <td class="num">${qtyBadge(l.good)}</td>
          <td class="num">${l.damaged ? `<span class="qty zero">${l.damaged}</span>` : '0'}</td>
          <td class="num">${gel(l.revenue)}</td>
          <td class="num">${l.avg_price != null ? gel(l.avg_price) : '—'}</td>
          <td><div class="row-actions">
            ${l.good || l.damaged ? '<button class="sm" data-action="basket">+ კალათაში</button>' : ''}
            ${l.good ? '<button class="sm secondary" data-action="damage">დაზიანება</button>' : ''}
            <button class="sm secondary" data-action="correct">შესწორება</button>
            ${l.has_sales ? '' : '<button class="sm danger" data-action="remove" title="წაშლა">×</button>'}
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="empty">ამ კონტეინერში ჯერ ნაწილები არ არის. დაამატეთ ზემოთ.</p>';
  filterLots();

  $('#cd-history').innerHTML = `
    <summary>ისტორია (${detail.history.length})</summary>
    ${detail.history.length ? `<div class="table-wrap"><table>
      <thead><tr><th>თარიღი</th><th>მოვლენა</th><th>ნაწილი</th><th>ცვლილება</th><th>შენიშვნა</th></tr></thead>
      <tbody>${detail.history.map((h) => `
        <tr><td>${dateLabel(h.date)}</td><td>${EVENT_NAMES[h.type] ?? h.type}</td><td>${esc(h.label)}</td>
          <td>${changeText(h)}</td><td>${esc(h.note)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="hint">ჯერ არაფერი მომხდარა.</p>'}`;

  if (!addFormDirty) renderAddForm();
}

function changeText(h) {
  const part = (n, word) => (n ? `${n > 0 ? '+' : ''}${n} ${word}` : '');
  return [part(h.good_change, 'მარაგი'), part(h.damaged_change, 'დაზიან.'), h.amount != null ? gel(h.amount) : '']
    .filter(Boolean).join(', ');
}

function filterLots() {
  for (const tr of $$('#cd-lines tbody tr')) tr.hidden = !!lotSearch && !tr.dataset.search.includes(lotSearch);
}

$('#container-detail').addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action || !detail) return;
  const c = detail.container;
  if (action === 'back') {
    openId = null;
    return showContainers();
  }
  if (action === 'edit') return containerDialog(c);
  if (action === 'delete') {
    if (confirm(`წავშალო კონტეინერი „${c.name}“?`)) {
      const ok = await act(() => api('DELETE', `/api/containers/${c.id}`), 'კონტეინერი წაიშალა');
      if (ok) { openId = null; showContainers(); }
    }
    return;
  }

  const tr = e.target.closest('tr[data-lot]');
  if (!tr) return;
  const lot = detail.lots.find((l) => l.lot_id === Number(tr.dataset.lot));
  if (action === 'basket') addToBasket(lot.part_id, { lotId: lot.lot_id, damaged: lot.good === 0 });
  if (action === 'damage') damageDialog(lot);
  if (action === 'correct') correctDialog(lot);
  if (action === 'remove' && confirm(`წავშალო „${lot.label}“ ამ კონტეინერიდან?`))
    act(() => api('DELETE', `/api/lots/${lot.lot_id}`), 'წაიშალა');
});

function damageDialog(lot) {
  const form = openDialog({
    title: `${esc(lot.label)} — დაზიანებულად მონიშვნა`,
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

function correctDialog(lot) {
  openDialog({
    title: `${esc(lot.label)} — შესწორება`,
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

// ---------- adding parts to the container ----------

function renderAddForm() {
  const box = $('#cd-add');
  if (!box) return;
  if (!state.categories.length) {
    box.innerHTML = `<h3>ნაწილის დამატება</h3>
      <p class="hint">ჯერ შექმენით კატეგორია: <b>ადმინი → კატეგორიები და ველები</b> (მაგ. „ამორტიზატორი“ ველებით „ბრენდი, მანქანა“).</p>`;
    return;
  }
  if (!findCat(addCategory)) addCategory = state.categories[0].id;
  box.innerHTML = `
    <h3>ნაწილის დამატება კონტეინერში</h3>
    <form id="add-item-form" class="add-grid">
      <label>კატეგორია
        <select name="category">${state.categories.map((c) => `<option value="${c.id}" ${c.id === addCategory ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      </label>
      <div class="pickers">${pickers(findCat(addCategory))}</div>
      <label>რაოდენობა <input name="quantity" type="number" min="1" step="1" value="1" required></label>
      <label>მათ შორის დაზიანებული <input name="damaged" type="number" min="0" step="1" value="0"></label>
      <button type="submit">დამატება</button>
    </form>
    <p class="hint">თუ ეს ნაწილი ამ კონტეინერში უკვე არის, რაოდენობა მას დაემატება.</p>`;
  const form = $('#add-item-form');
  form.addEventListener('input', () => { addFormDirty = true; });
  form.elements.category.addEventListener('change', (e) => {
    addCategory = Number(e.target.value);
    $('.pickers', form).innerHTML = pickers(findCat(addCategory));
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button[type=submit]', form);
    button.disabled = true;
    try {
      const cat = findCat(addCategory);
      const result = await api('POST', `/api/containers/${openId}/items`, {
        category_id: addCategory, values: collectValues(form),
        quantity: form.elements.quantity.value, damaged: form.elements.damaged.value || 0,
      });
      addFormDirty = false;
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
