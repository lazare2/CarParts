// shared helpers: data loading, formatting, dialogs, money fields, part labels

export const MONTHS = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი',
  'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => Number(n || 0).toLocaleString('ka-GE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const gel = (n) => `${fmt(n)} ₾`;
export const usd = (n) => `$${fmt(n)}`;
export const monthLabel = (m) => { const [y, mo] = m.split('-'); return `${MONTHS[Number(mo) - 1]} ${y}`; };
export const dateLabel = (d) => d.split('-').reverse().join('.');
export const byText = (a, b) => a.localeCompare(b, 'ka');
export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// "27 000 ₾ ($10 000 × 2.7)" for an amount that was entered in dollars
export const moneyLabel = (gelValue, amount, currency, rate) =>
  currency === 'USD' ? `${gel(gelValue)} <small class="muted">(${usd(amount)} × ${fmt(rate)})</small>` : gel(gelValue);

// ---------- data ----------

export const state = { categories: [], containers: [], referrers: [] };

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'შეცდომა');
  return data;
}

// every view registers a render function; refresh() reloads the catalog and redraws them
const renderers = [];
export const onRefresh = (fn) => renderers.push(fn);
export async function refresh() {
  Object.assign(state, await api('GET', '/api/catalog'));
  for (const render of renderers) await render();
}

export const visible = (panelId) => !$(`#${panelId}`).hidden;

let messageTimer;
export function showMessage(text, ok = true) {
  const el = $('#message');
  el.textContent = text;
  el.className = `message ${ok ? 'ok' : 'err'}`;
  el.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (el.hidden = true), 4500);
}

// run an action, refresh, then show the result. okText can be a function of the result.
export async function act(fn, okText) {
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

export const findCat = (id) => state.categories.find((c) => c.id === Number(id));
export function findPart(id) {
  for (const cat of state.categories) {
    const part = cat.parts.find((p) => p.id === Number(id));
    if (part) return { cat, part };
  }
  return null;
}
export const containerName = (id) => state.containers.find((c) => c.id === id)?.name ?? '?';
const optionText = (field, optionId) => field.options.find((o) => o.id === optionId)?.value ?? '';
export const partCells = (cat, part) => cat.fields.map((f) => optionText(f, part.values[f.id]));
export const partDetails = (cat, part) => partCells(cat, part).filter(Boolean).join(' · ');
export function partLabel(cat, part) {
  const d = partDetails(cat, part);
  return d ? `${cat.name} — ${d}` : cat.name;
}
// "MSKU123: 2 · TCLU456: 4" (only containers that still have good units)
export const lotSummary = (part, key = 'good') =>
  part.lots.filter((l) => l[key] > 0).map((l) => `${esc(containerName(l.container_id))}: <b>${l[key]}</b>`).join(' · ');

export const qtyBadge = (n) => `<span class="qty ${n === 0 ? 'zero' : n <= 2 ? 'low' : ''}">${n}</span>`;
export const stat = (label, value, cls = '') => `<div class="stat ${cls}"><b>${value}</b><span>${label}</span></div>`;

// dropdown for every field of a category, plus a box to type a brand-new value
export function pickers(cat, current = {}) {
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

export function collectValues(root) {
  const values = {};
  $$('.picker', root).forEach((p) => {
    const newValue = $('.pick-new', p).value.trim();
    const option = $('.pick', p).value;
    values[p.dataset.field] = newValue ? { new_value: newValue } : option ? { option_id: Number(option) } : {};
  });
  return values;
}

// ---------- dialogs ----------

// generic popup form. onSubmit returns a success message, or throws to show the error inside the popup.
export function openDialog({ title, body, submit, onSubmit, wide = false }) {
  const dlg = document.createElement('dialog');
  if (wide) dlg.classList.add('wide');
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
  const form = $('form', dlg);
  const errEl = $('.dlg-error', dlg);
  $('[data-cancel]', dlg).addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button[type=submit]', form);
    button.disabled = true;
    try {
      const text = await onSubmit(form);
      dlg.close();
      await refresh();
      if (text) showMessage(text);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  wireMoney(form);
  dlg.showModal();
  return form;
}

// ---------- money in ₾ or $ ----------

const RATE_KEY = 'carparts.usdRate';
export function lastRate() {
  try { return localStorage.getItem(RATE_KEY) ?? ''; } catch { return ''; }
}
export function saveRate(rate) {
  try { if (Number(rate) > 0) localStorage.setItem(RATE_KEY, String(rate)); } catch { /* not important */ }
}

// amount + ₾/$ switch; choosing $ asks for the exchange rate and shows the value in lari
export function moneyField(name, label, { amount = '', currency = 'GEL', rate = '' } = {}) {
  return `
    <div class="money" data-money="${name}">
      <label>${label}
        <span class="money-row">
          <input name="${name}_amount" type="number" min="0" step="0.01" value="${amount}" required>
          <select name="${name}_currency" aria-label="ვალუტა">
            <option value="GEL" ${currency !== 'USD' ? 'selected' : ''}>₾ ლარი</option>
            <option value="USD" ${currency === 'USD' ? 'selected' : ''}>$ დოლარი</option>
          </select>
        </span>
      </label>
      <label class="rate-row">კურსი: 1 $ = ? ₾
        <input name="${name}_rate" type="number" min="0" step="0.0001" value="${rate || lastRate()}"></label>
      <p class="hint money-gel"></p>
    </div>`;
}

export function wireMoney(root) {
  $$('[data-money]', root).forEach((box) => {
    const name = box.dataset.money;
    const amount = root.elements[`${name}_amount`];
    const currency = root.elements[`${name}_currency`];
    const rate = root.elements[`${name}_rate`];
    const preview = $('.money-gel', box);
    const update = () => {
      const isUsd = currency.value === 'USD';
      $('.rate-row', box).hidden = !isUsd;
      rate.required = isUsd;
      const value = Number(amount.value) * Number(rate.value);
      preview.hidden = !(isUsd && value > 0);
      preview.textContent = `= ${gel(Math.round(value * 100) / 100)}`;
    };
    for (const el of [amount, currency, rate]) el.addEventListener('input', update);
    currency.addEventListener('change', update);
    update();
  });
}

export function readMoney(form, name) {
  const get = (k) => form.elements[`${name}_${k}`].value;
  const currency = get('currency');
  if (currency === 'USD') saveRate(get('rate'));
  return { amount: get('amount'), currency, rate: currency === 'USD' ? get('rate') : null };
}

// who caused a return
export const RESPONSIBLE = {
  us: 'ჩვენ (ნაწილი დაზიანებული იყო)',
  referrer: 'ხელოსანი (არასწორი ნაწილი ურჩია)',
  customer: 'მყიდველი (გადაიფიქრა / არ მოერგო)',
  '': 'არ არის მითითებული',
};
export const RESPONSIBLE_SHORT = { us: 'ჩვენ', referrer: 'ხელოსანი', customer: 'მყიდველი', '': '—' };
