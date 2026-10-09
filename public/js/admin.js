// ადმინი: part types (variants) overview + categories, their fields and values
import {
  $, $$, esc, state, api, act, onRefresh, openDialog, findCat, findPart, partCells, partLabel, lotSummary,
  pickers, collectValues, qtyBadge, stat, byText,
} from './core.js';

// ---------- sub tabs ----------

$$('.sub').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.sub').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.subpanel').forEach((p) => (p.hidden = p.id !== `sub-${btn.dataset.sub}`));
  }));

// ---------- part types ----------

const closed = new Set();   // categories collapsed in the list (all open by default)

function updateToggleAll() {
  const ids = state.categories.filter((c) => c.parts.length).map((c) => c.id);
  $('#toggle-all').textContent = ids.every((id) => closed.has(id)) ? 'ყველას გაშლა' : 'ყველას დაკეცვა';
}

function renderVariants() {
  const q = $('#variant-search').value.trim().toLowerCase();
  const allParts = state.categories.flatMap((c) => c.parts);
  const good = allParts.reduce((sum, p) => sum + p.good, 0);
  const damaged = allParts.reduce((sum, p) => sum + p.damaged, 0);
  const soldOut = allParts.filter((p) => p.lots.length && p.good === 0).length;
  $('#variant-stats').innerHTML =
    stat('კატეგორია', state.categories.length) +
    stat('ნაწილის სახეობა', allParts.length) +
    stat('მარაგში (კარგი)', good) +
    stat('დაზიანებული', damaged, damaged ? 'bad' : '') +
    stat('ამოწურულია', soldOut, soldOut ? 'warn' : '');

  let html = '';
  let shown = 0;
  for (const cat of state.categories) {
    if (!cat.parts.length) continue;
    const catMatches = cat.name.toLowerCase().includes(q);
    const rows = cat.parts
      .map((part) => ({ part, cells: partCells(cat, part) }))
      .filter((r) => !q || catMatches || r.cells.some((c) => c.toLowerCase().includes(q)))
      .sort((a, b) => byText(a.cells.join(' '), b.cells.join(' ')));
    if (!rows.length) continue;
    shown++;
    const total = cat.parts.reduce((sum, p) => sum + p.good, 0);
    html += `
      <details class="cat" data-vcat="${cat.id}" ${q || !closed.has(cat.id) ? 'open' : ''}>
        <summary><span class="cat-name">${esc(cat.name)}</span>
          <span class="cat-total">სახეობა: ${cat.parts.length} · მარაგში: ${total}</span></summary>
        <table>
          <thead><tr>
            ${cat.fields.map((f) => `<th>${esc(f.name)}</th>`).join('')}
            <th>კონტეინერები (კარგი)</th><th class="num">მარაგში</th><th class="num">დაზიან.</th><th></th>
          </tr></thead>
          <tbody>${rows.map(({ part, cells }) => `
            <tr data-part="${part.id}">
              ${cells.map((c) => `<td>${c ? esc(c) : '—'}</td>`).join('')}
              <td class="lots">${lotSummary(part) || '<span class="muted">—</span>'}</td>
              <td class="num">${qtyBadge(part.good)}</td>
              <td class="num">${part.damaged ? `<span class="qty zero">${part.damaged}</span>` : '0'}</td>
              <td><div class="row-actions">
                ${cat.fields.length ? '<button class="sm secondary" data-action="edit">ცვლილება</button>' : ''}
                ${part.lots.length ? '' : '<button class="sm danger" data-action="delete" title="წაშლა">×</button>'}
              </div></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </details>`;
  }

  $('#admin-body').innerHTML = html;
  $('#admin-empty').hidden = allParts.length > 0;
  $('#admin-nomatch').hidden = !allParts.length || shown > 0;
  $('#toggle-all').hidden = !shown || !!q;
  updateToggleAll();
}

$('#variant-search').addEventListener('input', renderVariants);

$('#toggle-all').addEventListener('click', () => {
  const ids = state.categories.filter((c) => c.parts.length).map((c) => c.id);
  if (ids.every((id) => closed.has(id))) closed.clear();
  else ids.forEach((id) => closed.add(id));
  renderVariants();
});

$('#admin-body').addEventListener('toggle', (e) => {
  if ($('#variant-search').value.trim() || !e.target.dataset.vcat) return;
  const id = Number(e.target.dataset.vcat);
  if (e.target.open) closed.delete(id); else closed.add(id);
  updateToggleAll();
}, true);

$('#admin-body').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  const id = e.target.closest('tr').dataset.part;
  const { cat, part } = findPart(id);
  if (action === 'delete' && confirm(`წავშალო „${partLabel(cat, part)}“?`))
    act(() => api('DELETE', `/api/parts/${id}`), 'წაიშალა');
  if (action === 'edit')
    openDialog({
      title: `${esc(cat.name)} — ვარიანტის შეცვლა`,
      body: `<p class="hint">აქ ცვლით, რა წერია ამ ნაწილზე (მაგ. შეცდომით არჩეული ბრენდი). რაოდენობები არ იცვლება.</p>
        <div class="pickers">${pickers(cat, part.values)}</div>`,
      submit: 'შენახვა',
      async onSubmit(form) {
        await api('PATCH', `/api/parts/${id}`, { values: collectValues(form) });
        return 'ვარიანტი შეიცვალა';
      },
    });
});

// ---------- categories, fields and values ----------

const openCards = new Set();

function renderCategories() {
  $('#cat-list').innerHTML = state.categories.map((cat) => `
    <details class="card" data-cat="${cat.id}" ${openCards.has(cat.id) ? 'open' : ''}>
      <summary>
        <span class="card-title">${esc(cat.name)}</span>
        <span class="card-fields">${cat.fields.map((f) => `<span class="tag">${esc(f.name)}</span>`).join('') || '<span class="hint">ველების გარეშე</span>'}</span>
        <span class="badge">სახეობა: ${cat.parts.length}</span>
      </summary>
      <div class="card-body">
        <div class="card-tools">
          <input class="cat-name" value="${esc(cat.name)}" aria-label="კატეგორიის სახელი">
          <button class="sm secondary" data-action="cat-rename">სახელის შენახვა</button>
          <button class="sm danger" data-action="cat-delete">კატეგორიის წაშლა</button>
        </div>
        <div class="fields-grid">
          ${cat.fields.map((f) => `
            <div class="field" data-field="${f.id}">
              <div class="field-head">
                <input class="field-name" value="${esc(f.name)}" aria-label="ველის სახელი">
                <button class="sm secondary" data-action="field-rename">შენახვა</button>
                <button class="sm danger" data-action="field-delete">წაშლა</button>
              </div>
              <div class="chips">
                ${f.options.map((o) => `
                  <span class="chip" data-opt="${o.id}" data-value="${esc(o.value)}">${esc(o.value)}
                    <button class="link" data-action="opt-rename" title="შეცვლა">✎</button><button class="link" data-action="opt-delete" title="წაშლა">×</button>
                  </span>`).join('') || '<span class="hint">მნიშვნელობები ჯერ არ არის</span>'}
              </div>
              <div class="field-add">
                <input class="opt-new" placeholder="ახალი მნიშვნელობა">
                <button class="sm" data-action="opt-add">დამატება</button>
              </div>
            </div>`).join('')}
          <div class="field field-new-box">
            <div class="field-head"><b>ახალი ველი</b></div>
            <div class="field-add">
              <input class="field-new" placeholder="მაგ. ძრავი">
              <button class="sm" data-action="field-add">ველის დამატება</button>
            </div>
            ${cat.fields.length ? '' : '<p class="hint">ველების გარეშე კატეგორიას ერთი ვარიანტი ექნება.</p>'}
          </div>
        </div>
      </div>
    </details>`).join('') || '<p class="empty">კატეგორიები ჯერ არ არის.</p>';
}

$('#cat-list').addEventListener('toggle', (e) => {
  const id = Number(e.target.dataset.cat);
  if (e.target.open) openCards.add(id); else openCards.delete(id);
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
      act(() => api('PATCH', `/api/categories/${catId}`, { name: $('.cat-name', catEl).value }), 'სახელი შეიცვალა');
      break;
    case 'cat-delete':
      if (confirm(`წავშალო კატეგორია „${cat.name}“?`)) act(() => api('DELETE', `/api/categories/${catId}`), 'კატეგორია წაიშალა');
      break;
    case 'field-add':
      act(() => api('POST', `/api/categories/${catId}/fields`, { name: $('.field-new', catEl).value }), 'ველი დაემატა');
      break;
    case 'field-rename':
      act(() => api('PATCH', `/api/fields/${fieldEl.dataset.field}`, { name: $('.field-name', fieldEl).value }), 'ველის სახელი შეიცვალა');
      break;
    case 'field-delete':
      if (confirm('წავშალო ეს ველი მისი მნიშვნელობებით?')) act(() => api('DELETE', `/api/fields/${fieldEl.dataset.field}`), 'ველი წაიშალა');
      break;
    case 'opt-add':
      act(() => api('POST', `/api/fields/${fieldEl.dataset.field}/options`, { value: $('.opt-new', fieldEl).value }), 'მნიშვნელობა დაემატა');
      break;
    case 'opt-rename': {
      const value = prompt('ახალი მნიშვნელობა:', optEl.dataset.value);
      if (value !== null) act(() => api('PATCH', `/api/options/${optEl.dataset.opt}`, { value }), 'მნიშვნელობა შეიცვალა');
      break;
    }
    case 'opt-delete':
      if (confirm(`წავშალო „${optEl.dataset.value}“?`)) act(() => api('DELETE', `/api/options/${optEl.dataset.opt}`), 'მნიშვნელობა წაიშალა');
      break;
  }
});

$('#new-category').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fields = form.elements.fields.value.split(',').map((s) => s.trim()).filter(Boolean);
  const result = await act(() => api('POST', '/api/categories', { name: form.elements.name.value, fields }), 'კატეგორია დაემატა');
  if (result) {
    openCards.add(result.id);
    form.reset();
    renderCategories();
  }
});

onRefresh(() => { renderVariants(); renderCategories(); });
