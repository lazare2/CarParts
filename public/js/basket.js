// the basket: collect parts, then sell them in one go (optionally sent by a repairman)
import {
  $, $$, esc, gel, fmt, today, state, api, showMessage, openDialog, findPart, partLabel, containerName,
  lastRate, saveRate, onRefresh,
} from './core.js';

// { part_id, lot_id (null = oldest with stock), damaged, quantity }
let items = [];

// how many of this cart line can be taken: a chosen container (good or damaged), otherwise all good stock
function available(item) {
  const found = findPart(item.part_id);
  if (!found) return 0;
  if (item.lot_id) {
    const lot = found.part.lots.find((l) => l.id === item.lot_id);
    return lot ? (item.damaged ? lot.damaged : lot.good) : 0;
  }
  return found.part.good;
}

export function addToBasket(partId, { lotId = null, damaged = false } = {}) {
  const same = items.find((i) => i && i.part_id === partId && i.lot_id === lotId && i.damaged === damaged);
  const found = findPart(partId);
  const label = found ? partLabel(found.cat, found.part) : '';
  if (same) {
    if (same.quantity >= available(same)) return showMessage(`${label}: მარაგში მეტი აღარ არის`, false);
    same.quantity += 1;
  } else {
    items.push({ part_id: partId, lot_id: lotId, damaged, quantity: 1 });
  }
  renderCart();
  showMessage(`კალათაში დაემატა: ${label}`);
}

// (lines removed inside the open checkout are null until it closes, so indexes stay valid)
function renderCart() {
  const live = items.map((item, idx) => ({ item, idx })).filter(({ item }) => item && findPart(item.part_id));
  const count = live.reduce((sum, { item }) => sum + item.quantity, 0);
  $('#cart-count').textContent = live.length ? `${count} ც.` : '';
  $('#cart-empty').hidden = live.length > 0;
  $('#cart-checkout').disabled = !live.length;
  $('#cart-clear').disabled = !live.length;
  const indicator = $('#cart-indicator');
  indicator.hidden = !live.length;
  $('span', indicator).textContent = count;
  $('#cart-items').innerHTML = live.map(({ item, idx }) => {
    const { cat, part } = findPart(item.part_id);
    const details = partLabel(cat, part).slice(cat.name.length).replace(/^ — /, '');
    const max = available(item);
    return `
      <div class="cart-item" data-idx="${idx}">
        <div class="ci-text">
          <b>${esc(cat.name)}</b>
          ${details ? `<span class="details">${esc(details)}</span>` : ''}
          ${item.lot_id ? `<span class="lot-pill${item.damaged ? ' bad' : ''}">${esc(containerName(part.lots.find((l) => l.id === item.lot_id)?.container_id))}${item.damaged ? ' · დაზიანებული' : ''}</span>` : ''}
        </div>
        <div class="ci-qty">
          <button class="qbtn" data-dec title="ერთით ნაკლები">−</button>
          <span>${item.quantity}</span>
          <button class="qbtn" data-inc title="ერთით მეტი" ${item.quantity >= max ? 'disabled' : ''}>+</button>
        </div>
        <button class="link ci-remove" data-remove title="ამოღება">×</button>
      </div>`;
  }).join('');
}

$('#cart-items').addEventListener('click', (e) => {
  const row = e.target.closest('[data-idx]');
  if (!row) return;
  const item = items[Number(row.dataset.idx)];
  if (e.target.hasAttribute('data-inc') && item.quantity < available(item)) item.quantity += 1;
  if (e.target.hasAttribute('data-dec')) item.quantity -= 1;
  if (e.target.hasAttribute('data-remove') || item.quantity <= 0) items.splice(Number(row.dataset.idx), 1);
  renderCart();
});
$('#cart-clear').addEventListener('click', () => { items = []; renderCart(); });
$('#cart-checkout').addEventListener('click', () => openCheckout());
$('#cart-indicator').addEventListener('click', () => $('.tab[data-tab="parts"]').click());
onRefresh(renderCart);

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
      renderCart();
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
  form.closest('dialog').addEventListener('close', () => { items = items.filter(Boolean); renderCart(); });

  recalc();
  $('.price', form)?.focus();
}
