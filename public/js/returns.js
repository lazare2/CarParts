// დაბრუნება: a customer brings parts back (from an order, or without one) and maybe takes others instead
import {
  $, $$, esc, gel, fmt, dateLabel, today, state, api, act, showMessage, refresh, onRefresh, visible,
  findPart, partLabel, containerName, lastRate, saveRate, RESPONSIBLE, RESPONSIBLE_SHORT,
} from './core.js';

let orders = [];      // GET /api/sales
let lots = [];        // GET /api/lots (to know what was sold from which container)
let history = [];     // GET /api/exchanges

const fresh = () => ({
  mode: 'order', saleId: null, search: '',
  lines: {},          // order line id -> { qty, condition, credit, creditTouched }
  loose: [],          // { lot_id, part_id, qty, condition, credit }
  newItems: [],       // { lot_id, part_id, damaged, qty, price }
  referrerId: '', pct: '', pctTouched: false, apply: null,
  date: today(), currency: 'GEL', rate: lastRate(), responsible: '', note: '',
});
let f = fresh();

const rate = () => (f.currency === 'USD' ? Number(f.rate) || 0 : 1);
const toGel = (v) => Math.round((Number(v) || 0) * rate() * 100) / 100;
const fromGel = (g) => (rate() ? Math.round((g / rate()) * 100) / 100 : 0);
const sale = () => orders.find((o) => o.id === f.saleId);
const cur = () => (f.currency === 'USD' ? '$' : '₾');

export async function showReturns() {
  if (!visible('returns')) return;
  [orders, lots, history] = await Promise.all([api('GET', '/api/sales'), api('GET', '/api/lots'), api('GET', '/api/exchanges')]);
  if (f.saleId && !sale()) f.saleId = null;
  renderForm();
  renderHistory();
}
onRefresh(showReturns);

// opened from the finance list: "return something from this order"
export function openReturnFor(saleId) {
  f = fresh();
  f.saleId = saleId;
  $('.tab[data-tab="returns"]').click();
}

// ---------- the form ----------

function renderForm() {
  $('#ret-form').innerHTML = `
    <section class="ret-step">
      <span class="step-no">1</span>
      <div class="step-body">
        <div class="step-title">რა დააბრუნა მყიდველმა?</div>
        <div class="seg" id="ret-mode">
          <button data-mode="order" class="${f.mode === 'order' ? 'active' : ''}">შეკვეთიდან</button>
          <button data-mode="loose" class="${f.mode === 'loose' ? 'active' : ''}">შეკვეთის გარეშე (არ ახსოვს)</button>
        </div>
        <div id="ret-source">${f.mode === 'order' ? orderPart() : loosePart()}</div>
      </div>
    </section>
    <section class="ret-step">
      <span class="step-no">2</span>
      <div class="step-body">
        <div class="step-title">აიღო სხვა ნაწილი სანაცვლოდ? <span class="muted">— არასავალდებულო</span></div>
        ${newPart()}
      </div>
    </section>
    <section class="ret-step">
      <span class="step-no">3</span>
      <div class="step-body">
        <div class="step-title">დეტალები</div>
        <div class="ret-details">
          <label>თარიღი <input type="date" id="ret-date" value="${f.date}"></label>
          <label>ვალუტა <select id="ret-currency"><option value="GEL" ${f.currency === 'GEL' ? 'selected' : ''}>₾ ლარი</option>
            <option value="USD" ${f.currency === 'USD' ? 'selected' : ''}>$ დოლარი</option></select></label>
          <label ${f.currency === 'USD' ? '' : 'hidden'}>კურსი: 1 $ = ? ₾ <input type="number" id="ret-rate" min="0" step="0.0001" value="${esc(f.rate)}"></label>
          <label class="grow">შენიშვნა <input id="ret-note" value="${esc(f.note)}" placeholder="მაგ. მანქანას არ მოერგო"></label>
        </div>
        <fieldset class="radios" id="ret-responsible"><legend>ვისი მიზეზით დაბრუნდა?</legend>
          ${Object.entries(RESPONSIBLE).map(([k, v]) => `
            <label class="check"><input type="radio" name="responsible" value="${k}" ${f.responsible === k ? 'checked' : ''}> ${v}</label>`).join('')}
        </fieldset>
      </div>
    </section>
    <section class="ret-summary" id="ret-summary"></section>`;
  renderSummary();
}

function orderPart() {
  const s = sale();
  if (!s) {
    const q = f.search.toLowerCase();
    const found = orders.filter((o) => !q || [dateLabel(o.date), o.referrer ?? '', String(o.total), ...o.items.map((i) => `${i.label} ${i.container}`)]
      .join(' ').toLowerCase().includes(q)).slice(0, 12);
    return `
      <input type="search" id="order-search" placeholder="ძებნა: ნაწილი, ხელოსანი, თარიღი (მაგ. 05.10), თანხა..." value="${esc(f.search)}">
      <div class="order-list">${found.map((o) => `
        <button class="order-pick" data-sale="${o.id}">
          <span class="op-date">${dateLabel(o.date)}</span>
          <span class="op-items">${o.items.map((i) => `${esc(i.label)}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ')}
            ${o.exchange_id ? ' <span class="tag">გაცვლა</span>' : ''}</span>
          <span class="op-ref">${o.referrer ? esc(o.referrer) : '<span class="muted">ხელოსნის გარეშე</span>'}</span>
          <b>${gel(o.total)}</b>
        </button>`).join('') || '<p class="hint">შეკვეთა ვერ მოიძებნა. თუ მყიდველს არ ახსოვს, აირჩიეთ „შეკვეთის გარეშე“.</p>'}</div>`;
  }
  return `
    <div class="order-chosen">
      <b>შეკვეთა ${dateLabel(s.date)}</b>
      <span>${s.referrer ? `ხელოსანი: <b>${esc(s.referrer)}</b>` : '<span class="muted">ხელოსნის გარეშე</span>'}</span>
      <span>სულ: ${gel(s.total)}</span>
      <span class="grow"></span>
      <button class="sm secondary" id="order-change">სხვა შეკვეთა</button>
    </div>
    <table class="ret-table">
      <thead><tr><th>ნაწილი</th><th class="num">გაიყიდა</th><th class="num">ფასი</th><th>რამდენი ბრუნდება</th><th>მდგომარეობა</th><th>მყიდველს ერიცხება (${cur()})</th></tr></thead>
      <tbody>${s.items.map((i) => {
        const left = i.quantity - i.returned_qty;
        const l = f.lines[i.id] ?? { qty: 0, condition: 'good', credit: '' };
        return `
        <tr data-item="${i.id}">
          <td>${esc(i.label)} <span class="details">${esc(i.container)}${i.returned_qty ? ` · უკვე დაბრუნდა ${i.returned_qty}` : ''}</span></td>
          <td class="num">${i.quantity}</td>
          <td class="num">${gel(i.price_gel)}</td>
          <td>${left > 0 ? `<input class="r-qty" type="number" min="0" max="${left}" step="1" value="${l.qty}">` : '<span class="muted">ყველა დაბრუნდა</span>'}</td>
          <td>${left > 0 ? conditionSelect(l.condition) : ''}</td>
          <td>${left > 0 ? `<input class="r-credit" type="number" min="0" step="0.01" value="${l.credit}" ${l.qty ? '' : 'disabled'}>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

const conditionSelect = (c) => `<select class="r-cond">
  <option value="good" ${c === 'good' ? 'selected' : ''}>მუშაა — ბრუნდება მარაგში</option>
  <option value="damaged" ${c === 'damaged' ? 'selected' : ''}>დაზიანებულია</option></select>`;

// parts that were sold, and the containers they were sold from
function soldOptions() {
  const byPart = new Map();
  for (const l of lots.filter((x) => x.sold > 0)) (byPart.get(l.part_id) ?? byPart.set(l.part_id, []).get(l.part_id)).push(l);
  return byPart;
}

function partOptions(partIds, chosen) {
  const groups = new Map();
  for (const id of partIds) {
    const found = findPart(id);
    if (!found) continue;
    (groups.get(found.cat.name) ?? groups.set(found.cat.name, []).get(found.cat.name)).push({ id, label: partLabel(found.cat, found.part) });
  }
  return `<option value="">— აირჩიეთ ნაწილი —</option>` + [...groups].map(([cat, list]) => `<optgroup label="${esc(cat)}">${list
    .map((p) => `<option value="${p.id}" ${p.id === chosen ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</optgroup>`).join('');
}

function loosePart() {
  const sold = soldOptions();
  const lineRows = f.loose.map((l, i) => `
    <tr data-loose="${i}">
      <td>${esc(findPart(l.part_id) ? partLabel(findPart(l.part_id).cat, findPart(l.part_id).part) : '?')} <span class="details">${esc(containerName(lots.find((x) => x.lot_id === l.lot_id)?.container_id))}</span></td>
      <td class="num">${l.qty}</td>
      <td>${l.condition === 'good' ? 'მუშაა' : '<span class="tag bad">დაზიანებული</span>'}</td>
      <td class="num">${fmt(l.credit)} ${cur()}</td>
      <td><button class="link" data-remove-loose="${i}" title="ამოღება">×</button></td>
    </tr>`).join('');
  return `
    <div class="add-line" id="loose-add">
      <select class="la-part">${partOptions([...sold.keys()], null)}</select>
      <select class="la-lot" disabled><option value="">— კონტეინერი —</option></select>
      <input class="la-qty" type="number" min="1" step="1" value="1" title="რაოდენობა">
      ${conditionSelect('good').replace('r-cond', 'la-cond')}
      <input class="la-credit" type="number" min="0" step="0.01" placeholder="ერიცხება (${cur()})">
      <button class="sm" id="loose-add-btn">+ დამატება</button>
    </div>
    <p class="hint">შეკვეთის გარეშე: აირჩიეთ ნაწილი და კონტეინერი, საიდანაც ის გაიყიდა (სიაში მხოლოდ ისინია, საიდანაც ეს ნაწილი მართლა გაიყიდა).</p>
    ${f.loose.length ? `<table class="ret-table"><thead><tr><th>ნაწილი</th><th class="num">რაოდ.</th><th>მდგომარეობა</th><th class="num">ერიცხება</th><th></th></tr></thead>
      <tbody>${lineRows}</tbody></table>` : ''}
    <div class="ret-details">
      <label>ხელოსანი (თუ ცნობილია)
        <select id="loose-ref"><option value="">— არავინ / არ ვიცით —</option>
          ${state.referrers.filter((r) => r.active || String(r.id) === f.referrerId).map((r) => `<option value="${r.id}" ${String(r.id) === f.referrerId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select></label>
    </div>`;
}

// parts available to take instead (good or damaged units of every container)
function newPart() {
  const inStock = state.categories.flatMap((c) => c.parts).filter((p) => p.good + p.damaged > 0).map((p) => p.id);
  const rows = f.newItems.map((n, i) => `
    <tr data-new="${i}">
      <td>${esc(findPart(n.part_id) ? partLabel(findPart(n.part_id).cat, findPart(n.part_id).part) : '?')}
        <span class="details">${esc(containerName(state.categories.flatMap((c) => c.parts).flatMap((p) => p.lots).find((l) => l.id === n.lot_id)?.container_id))}${n.damaged ? ' · დაზიანებული' : ''}</span></td>
      <td class="num">${n.qty}</td>
      <td class="num">${fmt(n.price)} ${cur()}</td>
      <td><button class="link" data-remove-new="${i}" title="ამოღება">×</button></td>
    </tr>`).join('');
  return `
    <div class="add-line" id="new-add">
      <select class="na-part">${partOptions(inStock, null)}</select>
      <select class="na-src" disabled><option value="">— საიდან —</option></select>
      <input class="na-qty" type="number" min="1" step="1" value="1" title="რაოდენობა">
      <input class="na-price" type="number" min="0" step="0.01" placeholder="ფასი ჯამში (${cur()})">
      <button class="sm" id="new-add-btn">+ დამატება</button>
    </div>
    ${f.newItems.length ? `<table class="ret-table"><thead><tr><th>ახალი ნაწილი</th><th class="num">რაოდ.</th><th class="num">ფასი</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>` : ''}`;
}

// ---------- numbers ----------

function returnedLines() {
  if (f.mode === 'order') {
    const s = sale();
    if (!s) return [];
    return s.items.filter((i) => (f.lines[i.id]?.qty ?? 0) > 0).map((i) => ({ item: i, ...f.lines[i.id] }));
  }
  return f.loose;
}

function referrer() {
  if (f.mode === 'order') { const s = sale(); return s?.referrer_id ? state.referrers.find((r) => r.id === s.referrer_id) ?? { id: s.referrer_id, name: s.referrer } : null; }
  return f.referrerId ? state.referrers.find((r) => r.id === Number(f.referrerId)) : null;
}

function autoPct(lines) {
  if (f.mode === 'order') {
    const price = lines.reduce((s, l) => s + (l.item.price_gel * l.qty) / l.item.quantity, 0);
    const com = lines.reduce((s, l) => s + (l.item.commission_gel * l.qty) / l.item.quantity, 0);
    return price > 0 ? Math.round((com / price) * 10000) / 100 : 0;
  }
  return referrer()?.default_pct ?? 0;
}

function renderSummary() {
  const lines = returnedLines();
  const credit = lines.reduce((s, l) => s + toGel(l.credit), 0);
  const fresh = f.newItems.reduce((s, n) => s + toGel(n.price), 0);
  const cash = Math.round((fresh - credit) * 100) / 100;
  const ref = referrer();
  const pct = f.pctTouched ? Number(f.pct) || 0 : autoPct(lines);
  const delta = ref ? Math.round((pct / 100) * (fresh - credit) * 100) / 100 : 0;
  const apply = f.apply ?? delta > 0;

  $('#ret-summary').innerHTML = `
    <div class="sum-grid">
      <div><span>დაბრუნებული ნაწილები</span><b>${gel(credit)}</b></div>
      <div><span>სანაცვლოდ აღებული</span><b>${gel(fresh)}</b></div>
      <div class="sum-result ${cash < 0 ? 'pay-out' : cash > 0 ? 'pay-in' : ''}">
        ${cash < 0 ? `<span>მყიდველს დაუბრუნეთ</span><b>${gel(-cash)}</b>`
          : cash > 0 ? `<span>მყიდველმა უნდა გადაიხადოს</span><b>${gel(cash)}</b>`
          : `<span>სხვაობა</span><b>${lines.length ? 'თანაბარია' : '—'}</b>`}
      </div>
    </div>
    ${ref ? `
      <div class="ref-box">
        <div>ხელოსანი: <b>${esc(ref.name)}</b> · საკომისიო
          <input id="ret-pct" type="number" min="0" max="100" step="0.1" value="${f.pctTouched ? esc(f.pct) : pct}" title="%">%</div>
        ${delta === 0 ? '<div class="muted">საკომისიო არ იცვლება.</div>' : `
          <div>${delta < 0 ? `საკომისიო ამ დაბრუნებით მცირდება: <b class="loss">${gel(delta)}</b>`
            : `ძვირი ნაწილი: ხელოსანს ეკუთვნის დამატებით <b class="profit">+${gel(delta)}</b>`}</div>
          <label class="check"><input type="checkbox" id="ret-apply" ${apply ? 'checked' : ''}>
            ${delta < 0 ? `ჩამოვაჭრათ ხელოსანს ${gel(-delta)}` : `დავამატოთ ხელოსანს ${gel(delta)} საკომისიო`}</label>`}
        <p class="hint">ეს შემთხვევა ხელოსნის გვერდზე ჩაიწერება ნებისმიერ შემთხვევაში — მონიშნულია თუ არა.</p>
      </div>` : ''}
    <p class="dlg-error" id="ret-error" hidden></p>
    <div class="ret-actions">
      <button class="secondary" id="ret-reset">გასუფთავება</button>
      <button id="ret-submit" ${lines.length ? '' : 'disabled'}>${f.newItems.length ? 'გაცვლის ჩაწერა' : 'დაბრუნების ჩაწერა'}</button>
    </div>`;
}

// ---------- events ----------

const form = () => $('#ret-form');

$('#ret-form').addEventListener('click', async (e) => {
  const t = e.target;
  const mode = t.closest('[data-mode]')?.dataset.mode;
  if (mode && mode !== f.mode) { f.mode = mode; f.lines = {}; f.loose = []; f.apply = null; f.pctTouched = false; return renderForm(); }
  const pick = t.closest('[data-sale]');
  if (pick) { f.saleId = Number(pick.dataset.sale); f.lines = {}; f.apply = null; f.pctTouched = false; return renderForm(); }
  if (t.id === 'order-change') { f.saleId = null; f.lines = {}; return renderForm(); }
  if (t.dataset.removeLoose !== undefined) { f.loose.splice(Number(t.dataset.removeLoose), 1); return renderForm(); }
  if (t.dataset.removeNew !== undefined) { f.newItems.splice(Number(t.dataset.removeNew), 1); return renderForm(); }
  if (t.id === 'loose-add-btn') return addLoose();
  if (t.id === 'new-add-btn') return addNew();
  if (t.id === 'ret-reset') { f = fresh(); return renderForm(); }
  if (t.id === 'ret-submit') return submit();
});

$('#ret-form').addEventListener('input', (e) => {
  const t = e.target;
  // checkboxes/radios are handled on 'change'; redrawing here would replace them before that fires
  if (t.type === 'checkbox' || t.type === 'radio') return;
  if (t.id === 'order-search') {
    f.search = t.value;
    const pos = t.selectionStart;
    renderForm();
    const box = $('#order-search'); box.focus(); box.setSelectionRange(pos, pos);
    return;
  }
  const row = t.closest('tr[data-item]');
  if (row) {
    const item = sale().items.find((i) => i.id === Number(row.dataset.item));
    const l = (f.lines[item.id] ??= { qty: 0, condition: 'good', credit: '', creditTouched: false });
    if (t.classList.contains('r-qty')) {
      l.qty = Math.max(0, Math.min(Number(t.value) || 0, item.quantity - item.returned_qty));
      if (!l.creditTouched) l.credit = l.qty ? fromGel((item.price_gel / item.quantity) * l.qty) : '';
      $('.r-credit', row).value = l.credit;
      $('.r-credit', row).disabled = !l.qty;
    }
    if (t.classList.contains('r-credit')) { l.credit = t.value; l.creditTouched = true; }
  }
  if (t.id === 'ret-date') f.date = t.value;
  if (t.id === 'ret-note') f.note = t.value;
  if (t.id === 'ret-rate') { f.rate = t.value; recomputeCredits(); }
  if (t.id === 'ret-pct') { f.pct = t.value; f.pctTouched = true; return renderSummaryKeepFocus('ret-pct'); }
  renderSummary();
});

$('#ret-form').addEventListener('change', (e) => {
  const t = e.target;
  const row = t.closest('tr[data-item]');
  if (row && t.classList.contains('r-cond')) {
    const item = sale().items.find((i) => i.id === Number(row.dataset.item));
    (f.lines[item.id] ??= { qty: 0, condition: 'good', credit: '', creditTouched: false }).condition = t.value;
  }
  if (t.name === 'responsible') f.responsible = t.value;
  if (t.id === 'ret-apply') f.apply = t.checked;
  if (t.id === 'ret-currency') { f.currency = t.value; recomputeCredits(); return renderForm(); }
  if (t.id === 'loose-ref') { f.referrerId = t.value; f.pctTouched = false; f.apply = null; }
  if (t.classList.contains('la-part')) {
    const lotSel = $('.la-lot', form());
    const options = (soldOptions().get(Number(t.value)) ?? []);
    lotSel.innerHTML = options.map((l) => `<option value="${l.lot_id}">${esc(containerName(l.container_id))} — გაყიდულია ${l.sold}</option>`).join('')
      || '<option value="">— კონტეინერი —</option>';
    lotSel.disabled = !options.length;
  }
  if (t.classList.contains('na-part')) {
    const found = findPart(Number(t.value));
    const src = $('.na-src', form());
    const opts = found ? found.part.lots.flatMap((l) => [
      ...(l.good > 0 ? [`<option value="${l.id}|g">${esc(containerName(l.container_id))} — ${l.good} ც.</option>`] : []),
      ...(l.damaged > 0 ? [`<option value="${l.id}|d">${esc(containerName(l.container_id))} — დაზიანებული, ${l.damaged} ც.</option>`] : []),
    ]) : [];
    src.innerHTML = opts.join('') || '<option value="">— საიდან —</option>';
    src.disabled = !opts.length;
  }
  renderSummary();
});

function recomputeCredits() {
  const s = sale();
  if (s) for (const i of s.items) {
    const l = f.lines[i.id];
    if (l && l.qty && !l.creditTouched) l.credit = fromGel((i.price_gel / i.quantity) * l.qty);
  }
  for (const row of $$('tr[data-item]', form())) {
    const l = f.lines[Number(row.dataset.item)];
    if (l && $('.r-credit', row)) $('.r-credit', row).value = l.credit;
  }
}

function renderSummaryKeepFocus(id) {
  const pos = $(`#${id}`).selectionStart;
  renderSummary();
  const el = $(`#${id}`);
  el.focus();
  try { el.setSelectionRange(pos, pos); } catch { /* number inputs */ }
}

function addLoose() {
  const box = $('#loose-add');
  const partId = Number($('.la-part', box).value);
  const lotId = Number($('.la-lot', box).value);
  const qty = Number($('.la-qty', box).value);
  const credit = $('.la-credit', box).value;
  if (!partId || !lotId) return showMessage('აირჩიეთ ნაწილი და კონტეინერი', false);
  if (!(qty >= 1)) return showMessage('მიუთითეთ რაოდენობა', false);
  if (credit === '') return showMessage('მიუთითეთ, რა თანხა ერიცხება მყიდველს (შეიძლება 0)', false);
  f.loose.push({ part_id: partId, lot_id: lotId, qty, condition: $('.la-cond', box).value, credit: Number(credit) });
  renderForm();
}

function addNew() {
  const box = $('#new-add');
  const partId = Number($('.na-part', box).value);
  const [lotId, cond] = $('.na-src', box).value.split('|');
  const qty = Number($('.na-qty', box).value);
  const price = $('.na-price', box).value;
  if (!partId || !lotId) return showMessage('აირჩიეთ ნაწილი და საიდან აიღო', false);
  if (!(qty >= 1)) return showMessage('მიუთითეთ რაოდენობა', false);
  if (price === '') return showMessage('მიუთითეთ ახალი ნაწილის ფასი', false);
  f.newItems.push({ part_id: partId, lot_id: Number(lotId), damaged: cond === 'd', qty, price: Number(price) });
  renderForm();
}

async function submit() {
  const lines = returnedLines();
  const ref = referrer();
  const credit = lines.reduce((s, l) => s + toGel(l.credit), 0);
  const freshTotal = f.newItems.reduce((s, n) => s + toGel(n.price), 0);
  const pct = f.pctTouched ? Number(f.pct) || 0 : autoPct(lines);
  const delta = ref ? (pct / 100) * (freshTotal - credit) : 0;
  const body = {
    date: f.date, currency: f.currency, rate: f.currency === 'USD' ? f.rate : null, responsible: f.responsible, note: f.note,
    referrer_id: f.mode === 'loose' ? f.referrerId || null : null,
    commission_pct: f.pctTouched ? f.pct : '',
    apply_commission: f.apply ?? delta > 0,
    returned: lines.map((l) => (f.mode === 'order'
      ? { sale_item_id: l.item.id, quantity: l.qty, condition: l.condition, credit: l.credit }
      : { lot_id: l.lot_id, quantity: l.qty, condition: l.condition, credit: l.credit })),
    new_items: f.newItems.map((n) => ({ lot_id: n.lot_id, damaged: n.damaged, quantity: n.qty, price: n.price })),
  };
  const button = $('#ret-submit');
  button.disabled = true;
  try {
    if (f.currency === 'USD') saveRate(f.rate);
    const result = await api('POST', '/api/exchanges', body);
    f = fresh();
    await refresh();
    showMessage(result.cash_gel < 0 ? `ჩაიწერა. მყიდველს დაუბრუნეთ ${gel(-result.cash_gel)}`
      : result.cash_gel > 0 ? `ჩაიწერა. მყიდველმა გადაიხადოს ${gel(result.cash_gel)}` : 'ჩაიწერა. სხვაობა არ არის.');
  } catch (err) {
    $('#ret-error').textContent = err.message;
    $('#ret-error').hidden = false;
    button.disabled = false;
  }
}

// ---------- history ----------

function renderHistory() {
  $('#ret-history').innerHTML = history.length ? `
    <table class="ret-history">
      <thead><tr><th>თარიღი</th><th>დაბრუნდა</th><th>სანაცვლოდ აიღო</th><th class="num">ფული</th><th>ხელოსანი</th><th>მიზეზი</th><th class="num">საკომისიო</th><th></th></tr></thead>
      <tbody>${history.map((h) => `
        <tr>
          <td>${dateLabel(h.date)}<span class="details">${h.sale_date ? `შეკვეთა ${dateLabel(h.sale_date)}` : h.legacy ? '' : 'შეკვეთის გარეშე'}</span></td>
          <td>${h.returned.map((r) => `${esc(r.label)}${r.quantity > 1 ? ` ×${r.quantity}` : ''}${r.condition === 'damaged' ? ' <span class="tag bad">დაზ.</span>' : ''}<span class="details">${esc(r.container)} · ${gel(r.credit_gel)}</span>`).join('')}</td>
          <td>${h.taken.map((t) => `${esc(t.label)}${t.quantity > 1 ? ` ×${t.quantity}` : ''}<span class="details">${esc(t.container)} · ${gel(t.price_gel)}</span>`).join('') || '<span class="muted">—</span>'}</td>
          <td class="num"><b class="${h.cash_gel < 0 ? 'loss' : h.cash_gel > 0 ? 'profit' : ''}">${h.cash_gel < 0 ? '−' : h.cash_gel > 0 ? '+' : ''}${gel(Math.abs(h.cash_gel))}</b>
            <span class="details">${h.cash_gel < 0 ? 'დავუბრუნეთ' : h.cash_gel > 0 ? 'გადაიხადა' : 'თანაბარი'}</span></td>
          <td>${h.referrer ? esc(h.referrer) : '<span class="muted">—</span>'}</td>
          <td>${RESPONSIBLE_SHORT[h.responsible ?? '']}${h.note ? `<span class="details">${esc(h.note)}</span>` : ''}</td>
          <td class="num">${commissionText(h)}</td>
          <td>${h.can_undo ? `<button class="sm danger" data-undo="${h.id}" title="შეცდომით ჩაწერილის გაუქმება">გაუქმება</button>` : ''}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<p class="hint">დაბრუნებები ჯერ არ არის.</p>';
}

export function commissionText(h) {
  if (!h.referrer || !h.commission_delta_gel) return '<span class="muted">—</span>';
  const amount = `${h.commission_delta_gel > 0 ? '+' : '−'}${gel(Math.abs(h.commission_delta_gel))}`;
  return h.commission_applied
    ? `<b class="${h.commission_delta_gel > 0 ? 'profit' : 'loss'}">${amount}</b><span class="details">${h.commission_delta_gel > 0 ? 'დაემატა' : 'ჩამოიჭრა'}</span>`
    : `<span class="muted">${amount}</span><span class="details">არ ${h.commission_delta_gel > 0 ? 'დაემატა' : 'ჩამოიჭრა'}</span>`;
}

$('#ret-history').addEventListener('click', (e) => {
  const id = e.target.dataset.undo;
  if (id && confirm('გავაუქმო ეს დაბრუნება / გაცვლა? ნაწილები და ფული დაბრუნდება წინა მდგომარეობაში.'))
    act(() => api('DELETE', `/api/exchanges/${id}`), 'გაუქმდა');
});
