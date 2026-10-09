// ნაწილები: what is in stock (good units only), per category, with the containers they came from
import { $, esc, state, onRefresh, partCells, lotSummary, qtyBadge, byText } from './core.js';
import { addToBasket, openCheckout } from './basket.js';

const openCats = new Set();   // categories the user expanded

function render() {
  const q = $('#search').value.trim().toLowerCase();
  let html = '';
  let any = false;

  for (const cat of state.categories) {
    const received = cat.parts.filter((p) => p.lots.length);
    if (!received.length) continue;
    any = true;
    const catMatches = cat.name.toLowerCase().includes(q);
    const rows = received
      .map((part) => ({ part, cells: partCells(cat, part) }))
      .filter((r) => !q || catMatches || r.cells.some((c) => c.toLowerCase().includes(q)))
      .sort((a, b) => (b.part.good > 0) - (a.part.good > 0) || byText(a.cells.join(' '), b.cells.join(' ')));
    if (!rows.length) continue;

    const total = received.reduce((sum, p) => sum + p.good, 0);
    html += `
      <details class="cat" data-cat="${cat.id}" ${q || openCats.has(cat.id) ? 'open' : ''}>
        <summary><span class="cat-name">${esc(cat.name)}</span><span class="cat-total">მარაგში: ${total}</span></summary>
        <table>
          <thead><tr>
            ${cat.fields.map((f) => `<th>${esc(f.name)}</th>`).join('')}
            <th>კონტეინერები</th><th class="num">მარაგში</th><th></th>
          </tr></thead>
          <tbody>${rows.map(({ part, cells }) => `
            <tr>
              ${cells.map((c) => `<td>${c ? esc(c) : '—'}</td>`).join('')}
              <td class="lots">${lotSummary(part) || '<span class="muted">—</span>'}</td>
              <td class="num">${qtyBadge(part.good)}</td>
              <td><div class="row-actions">
                <button class="sm secondary" data-add="${part.id}" ${part.good ? '' : 'disabled'}>+ კალათაში</button>
                <button class="sm sell" data-sell="${part.id}" ${part.good ? '' : 'disabled'}>გაყიდვა</button>
              </div></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </details>`;
  }

  $('#parts-list').innerHTML = html;
  $('#parts-empty').hidden = any;
  $('#parts-nomatch').hidden = !any || html !== '';
}

$('#search').addEventListener('input', render);

$('#parts-list').addEventListener('toggle', (e) => {
  if ($('#search').value.trim()) return;   // searching opens everything; don't remember that
  const id = Number(e.target.dataset.cat);
  if (e.target.open) openCats.add(id); else openCats.delete(id);
}, true);

$('#parts-list').addEventListener('click', (e) => {
  const add = e.target.dataset.add;
  const sell = e.target.dataset.sell;
  if (add) addToBasket(Number(add));
  if (sell) {
    addToBasket(Number(sell));
    openCheckout();
  }
});

onRefresh(render);
