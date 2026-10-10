// ფინანსები: overview (numbers, chart, containers, repairmen) and the list of income/payments, for a chosen period
import {
  $, $$, esc, gel, fmt, dateLabel, monthLabel, today, MONTHS, api, act, onRefresh, visible, stat, moneyLabel,
} from './core.js';
import { barChart } from './charts.js';
import { openReturnFor } from './returns.js';

let sub = 'overview';
const now = today();
const period = { mode: 'month', year: Number(now.slice(0, 4)), month: Number(now.slice(5, 7)) };
const filters = { types: new Set(), referrer: '', container: '', q: '' };
const expanded = new Set();
let ledger = [];

const pad = (n) => String(n).padStart(2, '0');

function range() {
  if (period.mode === 'month') {
    const last = new Date(period.year, period.month, 0).getDate();
    return { from: `${period.year}-${pad(period.month)}-01`, to: `${period.year}-${pad(period.month)}-${pad(last)}` };
  }
  if (period.mode === 'year') return { from: `${period.year}-01-01`, to: `${period.year}-12-31` };
  return {};
}
const query = (extra = {}) => new URLSearchParams(Object.entries({ ...range(), ...extra }).filter(([, v]) => v)).toString();
const periodLabel = () => (period.mode === 'month' ? `${MONTHS[period.month - 1]} ${period.year}`
  : period.mode === 'year' ? `${period.year} წელი` : 'მთელი პერიოდი');

export async function showFinance() {
  if (!visible('finance')) return;
  renderPeriod();
  $('#fin-overview').hidden = sub !== 'overview';
  $('#fin-ledger').hidden = sub !== 'ledger';
  if (sub === 'overview') await loadOverview(); else await loadLedger();
}
onRefresh(showFinance);

// ---------- period switch: month / year / everything ----------

function renderPeriod() {
  $('#period').innerHTML = `
    <div class="seg">
      <button data-mode="month" class="${period.mode === 'month' ? 'active' : ''}">თვე</button>
      <button data-mode="year" class="${period.mode === 'year' ? 'active' : ''}">წელი</button>
      <button data-mode="all" class="${period.mode === 'all' ? 'active' : ''}">სრული</button>
    </div>
    <div class="period-nav">
      ${period.mode === 'all' ? '' : '<button class="sm secondary" data-step="-1" title="წინა">◀</button>'}
      <b>${periodLabel()}</b>
      ${period.mode === 'all' ? '' : '<button class="sm secondary" data-step="1" title="შემდეგი">▶</button>'}
    </div>`;
}

$('#period').addEventListener('click', (e) => {
  const mode = e.target.closest('[data-mode]')?.dataset.mode;
  const step = Number(e.target.closest('[data-step]')?.dataset.step);
  if (mode) period.mode = mode;
  if (step && period.mode === 'year') period.year += step;
  if (step && period.mode === 'month') {
    period.month += step;
    if (period.month < 1) { period.month = 12; period.year -= 1; }
    if (period.month > 12) { period.month = 1; period.year += 1; }
  }
  if (mode || step) showFinance();
});

$$('.fsub').forEach((btn) => btn.addEventListener('click', () => {
  $$('.fsub').forEach((b) => b.classList.toggle('active', b === btn));
  sub = btn.dataset.fsub;
  showFinance();
}));

// ---------- overview ----------

async function loadOverview() {
  const o = await api('GET', `/api/finance/overview?${query({ granularity: period.mode === 'month' ? 'day' : 'month' })}`);
  const t = o.totals;
  const chartData = o.chart.map((b) => ({
    label: o.granularity === 'day' ? String(Number(b.key.slice(8))) : `${MONTHS[Number(b.key.slice(5, 7)) - 1].slice(0, 3)}${period.mode === 'all' ? ` ${b.key.slice(2, 4)}` : ''}`,
    title: o.granularity === 'day' ? dateLabel(b.key) : monthLabel(b.key),
    values: [b.net, b.containers],
  }));
  const months = [...new Set(o.referrers.flatMap((r) => Object.keys(r.months)))].sort();

  $('#fin-overview').innerHTML = `
    <div class="stats kpis">
      ${stat('გაყიდვები', gel(t.sales))}
      ${stat('დაბრუნებები', gel(t.refunds))}
      ${stat('ხელოსნების საკომისიო', gel(t.commissions))}
      ${stat('წმინდა შემოსავალი', gel(t.net), 'good')}
      ${stat('კონტეინერების ხარჯი', gel(t.containers))}
      ${stat('შედეგი (შემოსავალი − კონტეინერები)', gel(t.result), t.result >= 0 ? 'good' : 'warn')}
      ${stat('ჩეკები / ნაწილები', `${t.receipts} / ${t.units}`)}
    </div>

    <section class="fin-card">
      <h3>შემოსავალი ${o.granularity === 'day' ? 'დღეების' : 'თვეების'} მიხედვით</h3>
      ${barChart({
        data: chartData,
        series: [{ name: 'წმინდა შემოსავალი', color: '#16a34a' }, { name: 'კონტეინერების ხარჯი', color: '#94a3b8' }],
      })}
      <p class="hint">წმინდა შემოსავალი = გაყიდვები − დაბრუნებები − ხელოსნების საკომისიო.</p>
    </section>

    <section class="fin-card">
      <div class="card-title-row">
        <h3>კონტეინერები — ფასი და ამოღებული თანხა</h3>
        <div class="avg-margin">საშუალო მარჟა: <b class="${o.avg_margin >= 0 ? 'profit' : 'loss'}">${o.avg_margin != null ? `${fmt(o.avg_margin)}%` : '—'}</b></div>
      </div>
      <p class="hint">მარჟა = მოგება ÷ გაყიდვები. სანამ კონტეინერი ბოლომდე არ გაიყიდება, მისი მარჟა უარყოფითია. საშუალო ითვლება ყველა კონტეინერზე ერთად, რომლიდანაც უკვე გაიყიდა რამე. „ამ პერიოდში“ — რამდენი შემოიტანა არჩეულ პერიოდში.</p>
      ${o.containers.length ? `<div class="table-wrap"><table class="fin-containers">
        <thead><tr><th>კონტეინერი</th><th class="num">ფასი</th><th class="num">ამოღებულია</th><th class="progress-col">ანაზღაურება</th>
          <th class="num">მოგება / ზარალი</th><th class="num">მარჟა</th><th class="num">ამ პერიოდში</th></tr></thead>
        <tbody>${o.containers.map((c) => `
          <tr>
            <td><b>${esc(c.name)}</b><span class="details">${dateLabel(c.arrival_date)} · მარაგში ${c.good} ც.</span></td>
            <td class="num">${moneyLabel(c.cost_gel, c.cost_amount, c.cost_currency, c.cost_rate)}</td>
            <td class="num">${gel(c.income)}</td>
            <td class="progress-col"><div class="progress"><span style="width:${Math.max(0, Math.min(100, c.recovered_pct ?? 0))}%"></span></div>
              <small>${c.recovered_pct != null ? `${fmt(c.recovered_pct)}%` : '—'}</small></td>
            <td class="num ${c.profit >= 0 ? 'profit' : 'loss'}">${gel(c.profit)}</td>
            <td class="num">${c.margin != null ? `${fmt(c.margin)}%` : '—'}</td>
            <td class="num">${gel(c.period_income)}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="hint">კონტეინერები ჯერ არ არის.</p>'}
    </section>

    <section class="fin-card">
      <h3>ხელოსნები — ${periodLabel()}</h3>
      ${o.referrers.length ? `<div class="table-wrap"><table>
        <thead><tr><th>ხელოსანი</th><th class="num">გამოგზავნილი კლიენტები</th><th class="num">ნაწილები</th><th class="num">გაყიდვები</th>
          <th class="num">საკომისიო</th><th class="num">გადახდილი</th><th class="num">ჯამში გადასახდელი</th></tr></thead>
        <tbody>${o.referrers.map((r) => `
          <tr><td>${esc(r.name)}</td><td class="num"><b>${r.visits}</b></td><td class="num">${r.units}</td><td class="num">${gel(r.sales)}</td>
            <td class="num">${gel(r.commission)}</td><td class="num">${gel(r.paid)}</td>
            <td class="num"><b class="${r.owed > 0 ? 'loss' : ''}">${gel(r.owed)}</b></td></tr>`).join('')}
        </tbody></table></div>
        ${period.mode !== 'month' && months.length ? `
          <h4>თვეების მიხედვით <span class="muted">(კლიენტები · საკომისიო)</span></h4>
          <div class="table-wrap"><table class="matrix">
            <thead><tr><th>ხელოსანი</th>${months.map((m) => `<th class="num">${monthLabel(m)}</th>`).join('')}</tr></thead>
            <tbody>${o.referrers.map((r) => `
              <tr><td>${esc(r.name)}</td>${months.map((m) => {
                const x = r.months[m];
                return `<td class="num">${x ? `<b>${x.visits}</b> კლ.<br><span class="muted">${gel(x.commission)}</span>` : '<span class="muted">—</span>'}</td>`;
              }).join('')}</tr>`).join('')}
            </tbody></table></div>` : ''}`
      : '<p class="hint">ხელოსნები ჯერ არ არის.</p>'}
    </section>`;
}

// ---------- income and payments ----------

const TYPES = { sale: 'გაყიდვა', exchange: 'დაბრუნება / გაცვლა', refund: 'ძველი დაბრუნება', payment: 'ხელოსნის გადახდა', container: 'კონტეინერი' };

async function loadLedger() {
  ledger = await api('GET', `/api/finance/ledger?${query()}`);
  const refs = new Map(ledger.filter((e) => e.referrer_id).map((e) => [e.referrer_id, e.referrer]));
  const conts = new Map();
  for (const e of ledger) {
    if (e.type === 'sale') for (const i of e.items) conts.set(i.container_id, i.container);
    if (e.container_id) conts.set(e.container_id, e.container ?? e.label);
  }
  if (filters.referrer && filters.referrer !== 'none' && !refs.has(Number(filters.referrer))) filters.referrer = '';
  if (filters.container && !conts.has(Number(filters.container))) filters.container = '';

  $('#fin-ledger').innerHTML = `
    <div class="filters ledger-filters">
      <div class="chip-row">${Object.entries(TYPES).map(([k, name]) => `
        <button class="fchip ${filters.types.has(k) ? 'active' : ''}" data-type="${k}">${name}</button>`).join('')}</div>
      <select id="lf-referrer" aria-label="ხელოსანი">
        <option value="">ყველა (ხელოსნით და მის გარეშე)</option>
        <option value="none" ${filters.referrer === 'none' ? 'selected' : ''}>მხოლოდ ხელოსნის გარეშე</option>
        ${[...refs].map(([id, name]) => `<option value="${id}" ${String(id) === filters.referrer ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>
      <select id="lf-container" aria-label="კონტეინერი">
        <option value="">ყველა კონტეინერი</option>
        ${[...conts].map(([id, name]) => `<option value="${id}" ${String(id) === filters.container ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>
      <input id="lf-search" type="search" placeholder="ძებნა..." value="${esc(filters.q)}">
    </div>
    <div id="ledger-sum" class="stats small"></div>
    <div id="ledger-table" class="table-wrap"></div>`;
  $('#lf-referrer').addEventListener('change', (e) => { filters.referrer = e.target.value; renderLedger(); });
  $('#lf-container').addEventListener('change', (e) => { filters.container = e.target.value; renderLedger(); });
  $('#lf-search').addEventListener('input', (e) => { filters.q = e.target.value.trim().toLowerCase(); renderLedger(); });
  renderLedger();
}

// entries passing the filters; with a container filter a receipt only counts its parts from that container
function visibleEntries() {
  const ref = filters.referrer;
  const cont = Number(filters.container) || null;
  return ledger.map((e) => {
    if (filters.types.size && !filters.types.has(e.type)) return null;
    if (ref === 'none' && (e.referrer_id || e.type === 'payment' || e.type === 'container')) return null;
    if (ref && ref !== 'none' && e.referrer_id !== Number(ref)) return null;
    let items = e.items;
    let amount = e.amount;
    if (cont) {
      if (e.type === 'exchange') {
    const list = (arr) => arr.map((x) => `${esc(x.label)}${x.quantity > 1 ? ` ×${x.quantity}` : ''}`).join(', ');
    return `დაბრუნდა: ${list(e.returned)}${e.taken.length ? `<br>აიღო: ${list(e.taken)}` : ''}
      <span class="details">${e.amount < 0 ? `მყიდველს დაუბრუნდა ${gel(-e.amount)}` : e.amount > 0 ? `მყიდველმა დაამატა ${gel(e.amount)}` : 'თანაბარი გაცვლა'}${e.note ? ` · ${esc(e.note)}` : ''}</span>`;
  }
  if (e.type === 'payment') return null;
      if (e.type === 'sale') {
        items = e.items.filter((i) => i.container_id === cont);
        if (!items.length) return null;
        amount = Math.round(items.reduce((s, i) => s + i.price_gel, 0) * 100) / 100;
      } else if (e.type === 'exchange') {
        if (!e.container_ids.includes(cont)) return null;
      } else if (e.container_id !== cont) return null;
    }
    const text = [e.label, e.referrer, e.note, e.container, ...(items ?? []).map((i) => `${i.label} ${i.container}`),
      ...(e.returned ?? []).map((r) => r.label), ...(e.taken ?? []).map((t) => t.label)].join(' ').toLowerCase();
    if (filters.q && !text.includes(filters.q)) return null;
    return { ...e, items, amount };
  }).filter(Boolean);
}

function describe(e) {
  if (e.type === 'sale') {
    const names = e.items.map((i) => `${esc(i.label)}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`);
    return `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` და კიდევ ${names.length - 2}` : ''}
      ${e.commission ? `<span class="details">საკომისიო: ${gel(e.commission)}</span>` : ''}`;
  }
  if (e.type === 'refund') return `${esc(e.label)} ×${e.quantity} <span class="details">${e.condition === 'damaged' ? 'დაზიანებული' : 'კარგი'} · გაიყიდა ${dateLabel(e.sale_date)}${e.note ? ` · ${esc(e.note)}` : ''}</span>`;
  if (e.type === 'exchange') {
    const list = (arr) => arr.map((x) => `${esc(x.label)}${x.quantity > 1 ? ` ×${x.quantity}` : ''}`).join(', ');
    return `დაბრუნდა: ${list(e.returned)}${e.taken.length ? `<br>აიღო: ${list(e.taken)}` : ''}
      <span class="details">${e.amount < 0 ? `მყიდველს დაუბრუნდა ${gel(-e.amount)}` : e.amount > 0 ? `მყიდველმა დაამატა ${gel(e.amount)}` : 'თანაბარი გაცვლა'}${e.note ? ` · ${esc(e.note)}` : ''}</span>`;
  }
  if (e.type === 'payment') return `საკომისიოს გადახდა${e.note ? `<span class="details">${esc(e.note)}</span>` : ''}`;
  return `კონტეინერი <b>${esc(e.label)}</b>${e.note ? `<span class="details">${esc(e.note)}</span>` : ''}`;
}

const amountCell = (e) => `<b class="${e.amount >= 0 ? 'profit' : 'loss'}">${e.amount >= 0 ? '+' : '−'}${gel(Math.abs(e.amount))}</b>
  ${e.currency === 'USD' ? `<span class="details">$${fmt(e.original ?? (e.items ?? []).reduce((s, i) => s + i.price_amount, 0))} × ${fmt(e.rate)}</span>` : ''}`;

function renderLedger() {
  $$('#fin-ledger [data-type]').forEach((b) => b.classList.toggle('active', filters.types.has(b.dataset.type)));
  const list = visibleEntries();
  const income = list.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  const out = list.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
  $('#ledger-sum').innerHTML = stat('შემოსული', gel(income), 'good') + stat('გასული', gel(-out)) +
    stat('ბალანსი', gel(income + out), income + out >= 0 ? 'good' : 'warn') + stat('ჩანაწერი', list.length);

  $('#ledger-table').innerHTML = list.length ? `
    <table class="ledger">
      <thead><tr><th>თარიღი</th><th>ტიპი</th><th>აღწერა</th><th>ხელოსანი</th><th class="num">თანხა</th></tr></thead>
      <tbody>${list.map((e) => `
        <tr class="lrow ${e.type === 'sale' ? 'clickable' : ''} ${expanded.has(e.key) ? 'open' : ''}" data-key="${e.key}">
          <td>${dateLabel(e.date)}</td>
          <td><span class="type type-${e.type}">${TYPES[e.type]}</span></td>
          <td>${describe(e)}</td>
          <td>${e.referrer ? esc(e.referrer) : '<span class="muted">—</span>'}</td>
          <td class="num">${amountCell(e)}</td>
        </tr>
        ${e.type === 'sale' && expanded.has(e.key) ? saleDetail(e) : ''}`).join('')}
      </tbody>
    </table>` : '<p class="empty">ამ ფილტრებით ჩანაწერები არ არის.</p>';
}

function saleDetail(e) {
  const full = ledger.find((x) => x.key === e.key);
  const hasReturns = full.items.some((i) => i.returned_qty > 0);
  return `
    <tr class="sale-detail" data-sale="${e.sale_id}"><td colspan="5">
      <table>
        <tbody>${e.items.map((i) => `
          <tr data-item="${i.id}">
            <td>${esc(i.label)} <span class="muted">· ${esc(i.container)}</span>${i.damaged ? ' <span class="tag bad">დაზიანებული</span>' : ''}</td>
            <td class="num">${i.quantity} ც.</td>
            <td class="num">${gel(i.price_gel)}</td>
            <td class="num">${e.referrer ? `${fmt(i.commission_pct)}% = ${gel(i.commission_gel)}` : ''}</td>
            <td class="num">${i.returned_qty ? `<span class="tag">დაბრუნდა ${i.returned_qty} ც. (${gel(i.refunded_gel)})</span>` : ''}</td>
            <td class="num">${i.returned_qty < i.quantity ? '<button class="sm secondary" data-action="return" title="დაბრუნების / გაცვლის გვერდზე გადასვლა">დაბრუნება →</button>' : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="sale-actions">
        ${e.note ? `<span class="muted">შენიშვნა: ${esc(e.note)}</span>` : ''}
        <span class="grow"></span>
        ${hasReturns ? '<span class="hint">დაბრუნების შემდეგ გაუქმება შეუძლებელია</span>'
          : '<button class="sm danger" data-action="cancel" title="შეცდომით შეყვანილი გაყიდვის გაუქმება">გაყიდვის გაუქმება</button>'}
      </div>
    </td></tr>`;
}

$('#fin-ledger').addEventListener('click', (e) => {
  const type = e.target.closest('[data-type]');
  if (type) {
    const k = type.dataset.type;
    if (filters.types.has(k)) filters.types.delete(k); else filters.types.add(k);
    return renderLedger();
  }
  const action = e.target.dataset.action;
  if (action) {
    const saleId = Number(e.target.closest('[data-sale]').dataset.sale);
    const sale = ledger.find((x) => x.sale_id === saleId);
    if (action === 'cancel' && confirm('გავაუქმო ეს გაყიდვა? ნაწილები მარაგში დაბრუნდება.'))
      act(() => api('DELETE', `/api/sales/${saleId}`), 'გაყიდვა გაუქმდა, ნაწილები მარაგში დაბრუნდა');
    if (action === 'return') openReturnFor(saleId);
    return;
  }
  const row = e.target.closest('tr.lrow.clickable');
  if (row) {
    if (expanded.has(row.dataset.key)) expanded.delete(row.dataset.key); else expanded.add(row.dataset.key);
    renderLedger();
  }
});
