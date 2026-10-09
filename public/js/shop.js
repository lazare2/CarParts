// ნაწილები (selling): category menu | parts in stock | cart
import { $, esc, state, onRefresh, containerName, byText } from './core.js';
import { addToBasket } from './basket.js';

let activeCat = 'all';

const optionText = (field, optionId) => field.options.find((o) => o.id === optionId)?.value ?? '';
const received = (cat) => cat.parts.filter((p) => p.lots.length);

function renderMenu(cats) {
  const total = cats.reduce((sum, c) => sum + received(c).reduce((s, p) => s + p.good, 0), 0);
  const item = (key, name, count, types) => `
    <button class="cat-item ${String(activeCat) === String(key) ? 'active' : ''} ${count ? '' : 'empty-cat'}" data-cat="${key}">
      <span class="cat-item-name">${esc(name)}${types != null ? `<small>${types} სახეობა</small>` : ''}</span>
      <span class="cat-count">${count}</span>
    </button>`;
  $('#cat-menu').innerHTML = item('all', 'ყველა', total, null) +
    cats.map((c) => item(c.id, c.name, received(c).reduce((s, p) => s + p.good, 0), received(c).length)).join('');
}

function partRow(cat, part) {
  const values = cat.fields.map((f) => ({ field: f.name, value: optionText(f, part.values[f.id]) })).filter((v) => v.value);
  const [first, ...rest] = values;
  const lots = part.lots.filter((l) => l.good > 0);
  return `
    <div class="part-row ${part.good ? '' : 'soldout'}">
      <div class="part-main">
        <div class="part-title">
          <b title="${esc(first?.field ?? '')}">${esc(first?.value ?? cat.name)}</b>
          ${rest.map((v) => `<span class="vchip"><i>${esc(v.field)}</i> ${esc(v.value)}</span>`).join('')}
        </div>
        <div class="part-lots">${lots.length
          ? lots.map((l) => `<span class="lot-pill">${esc(containerName(l.container_id))} <b>${l.good}</b></span>`).join('')
          : '<span class="muted">მარაგში აღარ არის</span>'}</div>
      </div>
      <div class="part-qty ${part.good === 0 ? 'zero' : part.good <= 2 ? 'low' : ''}"><b>${part.good}</b><span>ც.</span></div>
      <button class="add-btn" data-add="${part.id}" ${part.good ? '' : 'disabled'} title="კალათაში დამატება">+ კალათაში</button>
    </div>`;
}

function catSection(cat, parts, withHeader) {
  const rows = parts
    .map((part) => ({ part, key: cat.fields.map((f) => optionText(f, part.values[f.id])).join(' ') }))
    .sort((a, b) => (b.part.good > 0) - (a.part.good > 0) || byText(a.key, b.key))
    .map(({ part }) => partRow(cat, part)).join('');
  const total = parts.reduce((s, p) => s + p.good, 0);
  return `
    <section class="cat-section">
      ${withHeader ? `<h3 class="cat-header"><span>${esc(cat.name)}</span><span class="muted">${parts.length} სახეობა · ${total} ც.</span></h3>` : ''}
      ${rows}
    </section>`;
}

function render() {
  const cats = state.categories.filter((c) => received(c).length);
  if (activeCat !== 'all' && !cats.some((c) => c.id === activeCat)) activeCat = 'all';
  renderMenu(cats);
  const q = $('#search').value.trim().toLowerCase();

  let shown = cats;
  if (!q && activeCat !== 'all') shown = cats.filter((c) => c.id === activeCat);
  const sections = shown.map((cat) => {
    const catMatches = cat.name.toLowerCase().includes(q);
    const parts = received(cat).filter((p) => !q || catMatches ||
      cat.fields.some((f) => optionText(f, p.values[f.id]).toLowerCase().includes(q)));
    return parts.length ? catSection(cat, parts, q || activeCat === 'all') : '';
  }).filter(Boolean);

  const single = !q && activeCat !== 'all' ? cats.find((c) => c.id === activeCat) : null;
  $('#shop-head').innerHTML = q
    ? `<h2>ძებნა: „${esc(q)}“</h2>`
    : single
      ? `<h2>${esc(single.name)}</h2><span class="muted">${received(single).length} სახეობა · ${received(single).reduce((s, p) => s + p.good, 0)} ც. მარაგში</span>`
      : '<h2>ყველა ნაწილი</h2>';
  $('#parts-list').innerHTML = sections.join('');
  $('#parts-empty').hidden = cats.length > 0;
  $('#parts-nomatch').hidden = !cats.length || sections.length > 0;
}

$('#search').addEventListener('input', render);
$('#cat-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cat]');
  if (!btn) return;
  activeCat = btn.dataset.cat === 'all' ? 'all' : Number(btn.dataset.cat);
  $('#search').value = '';
  render();
});
$('#parts-list').addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add) addToBasket(Number(add.dataset.add));
});

onRefresh(render);
