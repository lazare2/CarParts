// the basket: collect parts, then sell them in one go (optionally sent by a repairman)
import {
  $, $$, esc, gel, fmt, today, state, api, showMessage, openDialog, findPart, partLabel, containerName,
  lastRate, saveRate, onRefresh,
} from './core.js';

// { part_id, lot_id (null = oldest with stock), damaged, quantity }
let items = [];

export function addToBasket(partId, { lotId = null, damaged = false } = {}) {
  const same = items.find((i) => i.part_id === partId && i.lot_id === lotId && i.damaged === damaged);
  if (same) same.quantity += 1;
  else items.push({ part_id: partId, lot_id: lotId, damaged, quantity: 1 });
  renderBar();
  const found = findPart(partId);
  showMessage(`კალათაში დაემატა: ${found ? partLabel(found.cat, found.part) : ''}`);
}

// (lines removed inside the open checkout are null until it closes, so indexes stay valid)
function renderBar() {
  const bar = $('#basket-bar');
  const live = items.map((item, idx) => ({ item, idx })).filter(({ item }) => item && findPart(item.part_id));
  bar.hidden = !live.length;
  if (!live.length) return;
  const count = live.reduce((sum, { item }) => sum + item.quantity, 0);
  $('#basket-count').textContent = `კალათაში: ${count} ცალი (${live.length} ნაწილი)`;
  $('#basket-list').innerHTML = live.map(({ item, idx }) => {
    const { cat, part } = findPart(item.part_id);
    return `<span class="chip">${esc(partLabel(cat, part))}${item.quantity > 1 ? ` × ${item.quantity}` : ''}
      <button class="link" data-basket-remove="${idx}" title="ამოღება">×</button></span>`;
  }).join('');
}

$('#basket-list').addEventListener('click', (e) => {
  const idx = e.target.dataset.basketRemove;
  if (idx === undefined) return;
  items.splice(Number(idx), 1);
  renderBar();
});
$('#basket-clear').addEventListener('click', () => { items = []; renderBar(); });
$('#basket-checkout').addEventListener('click', () => openCheckout());
onRefresh(renderBar);

// where a line can be taken from: every container that still has it, good or damaged
function sources(part) {
  const list = [];
  for (const lot of part.lots) {
    if (lot.good > 0) list.push({ value: `${lot.id}|g`, lot_id: lot.id, damaged: false, available: lot.good, text: `${containerName(lot.container_id)} — ${lot.good} ც.` });
    if (lot.damaged > 0) list.push({ value: `${lot.id}|d`, lot_id: lot.id, damaged: true, available: lot.damaged, text: `${containerName(lot.container_id)} — დაზიანებული, ${lot.damaged} ც.` });
  }
  return list;
}

export function openCheckout() {
  if (!items.length) return;
  const referrers = state.referrers.filter((r) => r.active);
  items = items.filter((item) => item && findPart(item.part_id));
  const rows = items.map((item, i) => {
    const { cat, part } = findPart(item.part_id);
    const options = sources(part);
    // the requested container, otherwise the oldest one that has good units (containers come oldest first)
    const chosen = options.find((o) => o.lot_id === item.lot_id && o.damaged === item.damaged)
      ?? options.find((o) => !o.damaged) ?? options[0];
    return `
      <tr data-i="${i}">
        <td>${esc(partLabel(cat, part))}</td>
        <td><select class="src">${options.map((o) => `<option value="${o.value}" data-max="${o.available}" ${o === chosen ? 'selected' : ''}>${esc(o.text)}</option>`).join('')
          || '<option value="">მარაგში აღარ არის</option>'}</select></td>
        <td><input class="line-qty" type="number" min="1" step="1" value="${Math.min(item.quantity, chosen?.available ?? 1)}" max="${chosen?.available ?? 0}" required></td>
        <td><input class="price" type="number" min="0" step="0.01" required placeholder="ჯამური ფასი"><div class="hint unit"></div></td>
        <td class="ref-col"><input class="pct" type="number" min="0" max="100" step="0.1" placeholder="%"></td>
        <td class="ref-col num com">—</td>
        <td class="ref-col num keep">—</td>
        <td><button type="button" class="link" data-remove title="ამოღება">×</button></td>
      </tr>`;
  }).join('');

  const form = openDialog({
    wide: true,
    title: 'გაყიდვა',
    body: `
      <div class="checkout-head">
        <label>თარიღი <input type="date" name="date" value="${today()}" required></label>
        <label>ვინ გამოგზავნა
          <select name="referrer">
            <option value="">— არავინ (ჩვეულებრივი გაყიდვა) —</option>
            ${referrers.map((r) => `<option value="${r.id}">${esc(r.name)}${r.default_pct != null ? ` (${fmt(r.default_pct)}%)` : ''}</option>`).join('')}
          </select></label>
        <label>ვალუტა
          <select name="currency"><option value="GEL">₾ ლარი</option><option value="USD">$ დოლარი</option></select></label>
        <label class="rate-row" hidden>კურსი: 1 $ = ? ₾ <input name="rate" type="number" min="0" step="0.0001" value="${lastRate()}"></label>
      </div>
      <div class="table-wrap">
        <table class="checkout no-ref">
          <thead><tr><th>ნაწილი</th><th>საიდან</th><th>რაოდ.</th><th>ფასი (ჯამში)</th>
            <th class="ref-col">%</th><th class="ref-col num">ხელოსანს</th><th class="ref-col num">თქვენ რჩება</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><th colspan="3">სულ</th><th class="total-price">—</th><th class="ref-col"></th>
            <th class="ref-col num total-com">—</th><th class="ref-col num total-keep">—</th><th></th></tr></tfoot>
        </table>
      </div>
      <label>შენიშვნა <input name="note" placeholder="არასავალდებულო"></label>`,
    submit: 'გაყიდვა',
    async onSubmit(f) {
      const currency = f.elements.currency.value;
      if (currency === 'USD') saveRate(f.elements.rate.value);
      const referrerId = f.elements.referrer.value || null;
      const lines = $$('tbody tr', f).map((tr) => {
        const [lotId, cond] = $('.src', tr).value.split('|');
        if (!lotId) throw new Error(`${$('td', tr).textContent}: მარაგში აღარ არის`);
        return {
          lot_id: Number(lotId), damaged: cond === 'd',
          quantity: $('.line-qty', tr).value, price: $('.price', tr).value,
          commission_pct: referrerId ? $('.pct', tr).value : 0,
        };
      });
      await api('POST', '/api/sales', {
        date: f.elements.date.value, referrer_id: referrerId, currency,
        rate: currency === 'USD' ? f.elements.rate.value : null, note: f.elements.note.value, items: lines,
      });
      const total = $('.total-price', f).textContent;
      items = [];
      renderBar();
      return `გაიყიდა ${lines.length} ნაწილი, სულ ${total}`;
    },
  });

  // ----- live numbers -----
  const table = $('table.checkout', form);
  const manualPct = new Set();   // rows whose % the user typed
  let pctSource = null;          // the first row the user typed a % in: it fills the untouched rows

  const rate = () => (form.elements.currency.value === 'USD' ? Number(form.elements.rate.value) || 0 : 1);

  function recalc() {
    const hasRef = !!form.elements.referrer.value;
    const isUsd = form.elements.currency.value === 'USD';
    table.classList.toggle('no-ref', !hasRef);
    $('.rate-row', form).hidden = !isUsd;
    form.elements.rate.required = isUsd;
    let sum = 0;
    let com = 0;
    for (const tr of $$('tbody tr', form)) {
      const priceGel = (Number($('.price', tr).value) || 0) * rate();
      const qty = Number($('.line-qty', tr).value) || 0;
      const c = hasRef ? (priceGel * (Number($('.pct', tr).value) || 0)) / 100 : 0;
      sum += priceGel;
      com += c;
      $('.unit', tr).textContent = priceGel && qty
        ? `${isUsd ? `= ${gel(priceGel)}, ` : ''}${gel(priceGel / qty)} / ც.` : '';
      $('.com', tr).textContent = gel(c);
      $('.keep', tr).textContent = gel(priceGel - c);
    }
    $('.total-price', form).textContent = gel(sum);
    $('.total-com', form).textContent = gel(com);
    $('.total-keep', form).textContent = gel(sum - com);
  }

  form.addEventListener('input', (e) => {
    const tr = e.target.closest('tbody tr');
    if (tr && e.target.classList.contains('pct')) {
      const i = tr.dataset.i;
      manualPct.add(i);
      if (pctSource === null) pctSource = i;
      if (pctSource === i)
        for (const other of $$('tbody tr', form))
          if (!manualPct.has(other.dataset.i)) $('.pct', other).value = e.target.value;
    }
    recalc();
  });

  form.addEventListener('change', (e) => {
    if (e.target.classList.contains('src')) {
      const max = Number(e.target.selectedOptions[0]?.dataset.max || 0);
      const qty = $('.line-qty', e.target.closest('tr'));
      qty.max = max;
      if (Number(qty.value) > max) qty.value = max;
    }
    if (e.target.name === 'referrer') {
      const ref = state.referrers.find((r) => r.id === Number(e.target.value));
      if (ref?.default_pct != null)
        for (const tr of $$('tbody tr', form)) if (!manualPct.has(tr.dataset.i)) $('.pct', tr).value = ref.default_pct;
    }
    recalc();
  });

  form.addEventListener('click', (e) => {
    if (!e.target.hasAttribute('data-remove')) return;
    const tr = e.target.closest('tr');
    items[Number(tr.dataset.i)] = null;
    tr.remove();
    if (!$$('tbody tr', form).length) form.closest('dialog').close();
    else recalc();
  });
  form.closest('dialog').addEventListener('close', () => { items = items.filter(Boolean); renderBar(); });

  recalc();
  $('.price', form)?.focus();
}
