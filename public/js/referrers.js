// ხელოსნები: repairmen who send customers, their commissions per month, and payments to them
import {
  $, esc, gel, fmt, dateLabel, monthLabel, today, api, act, showMessage, onRefresh, visible, openDialog,
  stat, moneyField, readMoney, moneyLabel,
} from './core.js';

let openId = null;
let detail = null;

export async function showReferrers() {
  if (!visible('referrers')) return;
  $('#referrers-list-view').hidden = !!openId;
  $('#referrer-detail').hidden = !openId;
  if (openId) await loadDetail(); else await loadList();
}
onRefresh(showReferrers);

// ---------- list ----------

let list = [];

async function loadList() {
  list = await api('GET', '/api/referrers');
  const owed = list.reduce((sum, r) => sum + Math.max(r.owed, 0), 0);
  const month = list.reduce((sum, r) => sum + r.earned_month, 0);
  $('#referrer-stats').innerHTML = list.length
    ? stat('ხელოსნები', list.filter((r) => r.active).length) + stat('საკომისიო ამ თვეში', gel(month)) + stat('სულ გადასახდელი', gel(owed), owed > 0 ? 'warn' : '')
    : '';
  $('#referrers-empty').hidden = list.length > 0;
  $('#referrer-table').innerHTML = list.length ? `
    <table>
      <thead><tr><th>სახელი</th><th>ტელეფონი</th><th class="num">ნაგულ. %</th><th class="num">ამ თვეში</th>
        <th class="num">სულ საკომისიო</th><th class="num">გადახდილი</th><th class="num">გადასახდელი</th><th></th></tr></thead>
      <tbody>${list.map((r) => `
        <tr data-id="${r.id}" class="${r.active ? '' : 'inactive'}">
          <td><a href="#" data-action="open">${esc(r.name)}</a>${r.active ? '' : ' <span class="tag">არააქტიური</span>'}</td>
          <td>${esc(r.phone) || '—'}</td>
          <td class="num">${r.default_pct != null ? `${fmt(r.default_pct)}%` : '—'}</td>
          <td class="num">${gel(r.earned_month)}</td>
          <td class="num">${gel(r.earned)}</td>
          <td class="num">${gel(r.paid)}</td>
          <td class="num"><b class="${r.owed > 0 ? 'loss' : ''}">${gel(r.owed)}</b></td>
          <td><div class="row-actions">
            <button class="sm" data-action="pay">გადახდა</button>
            <button class="sm secondary" data-action="open">დეტალები</button>
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table>` : '';
}

$('#referrer-table').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  e.preventDefault();
  const r = list.find((x) => x.id === Number(e.target.closest('tr').dataset.id));
  if (action === 'open') { openId = r.id; showReferrers(); }
  if (action === 'pay') paymentDialog(r);
});

$('#new-referrer-btn').addEventListener('click', () => referrerDialog());

function referrerDialog(r = null) {
  openDialog({
    title: r ? 'ხელოსნის რედაქტირება' : 'ახალი ხელოსანი',
    body: `
      <label>სახელი <input name="name" value="${esc(r?.name ?? '')}" required></label>
      <label>ტელეფონი <input name="phone" value="${esc(r?.phone ?? '')}"></label>
      <label>ნაგულისხმევი საკომისიო % <input name="default_pct" type="number" min="0" max="100" step="0.1" value="${r?.default_pct ?? ''}" placeholder="არასავალდებულო"></label>
      <p class="hint">გაყიდვისას ეს პროცენტი ავტომატურად ჩაიწერება, მაგრამ შეცვლა ყოველთვის შეიძლება.</p>
      <label>შენიშვნა <input name="note" value="${esc(r?.note ?? '')}" placeholder="მაგ. სერვისის მისამართი"></label>
      ${r ? `<label class="check"><input type="checkbox" name="active" ${r.active ? 'checked' : ''}> აქტიურია (ჩანს გაყიდვისას)</label>` : ''}`,
    submit: r ? 'შენახვა' : 'დამატება',
    async onSubmit(f) {
      const body = {
        name: f.elements.name.value, phone: f.elements.phone.value, default_pct: f.elements.default_pct.value,
        note: f.elements.note.value, active: r ? f.elements.active.checked : true,
      };
      if (r) await api('PATCH', `/api/referrers/${r.id}`, body);
      else await api('POST', '/api/referrers', body);
      return r ? 'შეინახა' : 'ხელოსანი დაემატა';
    },
  });
}

function paymentDialog(r) {
  const form = openDialog({
    title: `${esc(r.name)} — გადახდა`,
    body: `
      <p class="hint">ამჟამად გადასახდელია: <b>${gel(r.owed)}</b></p>
      ${moneyField('amount', 'გადახდილი თანხა', { amount: r.owed > 0 ? r.owed : '' })}
      <label>თარიღი <input name="date" type="date" value="${today()}" required></label>
      <label>შენიშვნა <input name="note" placeholder="არასავალდებულო"></label>`,
    submit: 'გადახდის ჩაწერა',
    async onSubmit(f) {
      await api('POST', `/api/referrers/${r.id}/payments`, { amount: readMoney(f, 'amount'), date: f.elements.date.value, note: f.elements.note.value });
      return `გადახდა ჩაიწერა: ${r.name}`;
    },
  });
  form.elements.amount_amount.select();
}

// ---------- one repairman ----------

async function loadDetail() {
  try {
    detail = await api('GET', `/api/referrers/${openId}`);
  } catch (err) {
    openId = null;
    showMessage(err.message, false);
    return showReferrers();
  }
  const r = detail.referrer;
  const thisMonth = today().slice(0, 7);
  $('#referrer-detail').innerHTML = `
    <div class="detail-head">
      <button class="sm secondary" data-action="back">← ყველა ხელოსანი</button>
      <h2>${esc(r.name)}</h2>
      <span class="muted">${esc(r.phone)}${r.default_pct != null ? ` · ნაგულისხმევი ${fmt(r.default_pct)}%` : ''}${r.note ? ` · ${esc(r.note)}` : ''}</span>
      ${r.active ? '' : '<span class="tag">არააქტიური</span>'}
      <span class="grow"></span>
      <button class="sm" data-action="pay">გადახდა</button>
      <button class="sm secondary" data-action="edit">რედაქტირება</button>
      <button class="sm danger" data-action="delete">წაშლა</button>
    </div>
    <div class="stats">
      ${stat('სულ საკომისიო', gel(detail.earned))}
      ${stat('გადახდილი', gel(detail.paid))}
      ${stat('გადასახდელი', gel(detail.owed), detail.owed > 0 ? 'warn' : '')}
    </div>

    <h3>საკომისიო თვეების მიხედვით</h3>
    ${detail.months.length ? detail.months.map((m, i) => `
      <details class="cat" ${i === 0 || m.month === thisMonth ? 'open' : ''}>
        <summary><span class="cat-name">${monthLabel(m.month)}</span>
          <span class="cat-total">გაყიდვები: ${gel(m.sales)} · საკომისიო: <b>${gel(m.earned)}</b></span></summary>
        <table>
          <thead><tr><th>თარიღი</th><th>ნაწილი</th><th class="num">რაოდ.</th><th class="num">ფასი</th><th class="num">%</th><th class="num">საკომისიო</th></tr></thead>
          <tbody>${m.lines.map((l) => `
            <tr class="${l.kind === 'return' ? 'return-row' : ''}">
              <td>${dateLabel(l.date)}</td>
              <td>${esc(l.label)}${l.damaged ? ' <span class="tag bad">დაზიანებული</span>' : ''}${l.kind === 'return' ? ' <span class="tag">დაბრუნება</span>' : ''}</td>
              <td class="num">${l.quantity}</td><td class="num">${gel(l.price)}</td>
              <td class="num">${fmt(l.pct)}%</td><td class="num">${gel(l.amount)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </details>`).join('') : '<p class="hint">ამ ხელოსნის გამოგზავნილი გაყიდვები ჯერ არ არის.</p>'}

    <h3>გადახდები</h3>
    ${detail.payments.length ? `
      <table>
        <thead><tr><th>თარიღი</th><th class="num">თანხა</th><th>შენიშვნა</th><th></th></tr></thead>
        <tbody>${detail.payments.map((p) => `
          <tr data-payment="${p.id}">
            <td>${dateLabel(p.date)}</td><td class="num">${moneyLabel(p.amount_gel, p.amount, p.currency, p.rate)}</td>
            <td>${esc(p.note)}</td>
            <td><button class="sm danger" data-action="delete-payment" title="წაშლა">×</button></td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<p class="hint">გადახდები ჯერ არ არის.</p>'}`;
}

$('#referrer-detail').addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action || !detail) return;
  const r = { ...detail.referrer, owed: detail.owed };
  if (action === 'back') { openId = null; showReferrers(); }
  if (action === 'pay') paymentDialog(r);
  if (action === 'edit') referrerDialog(r);
  if (action === 'delete' && confirm(`წავშალო ხელოსანი „${r.name}“?`)) {
    if (await act(() => api('DELETE', `/api/referrers/${r.id}`), 'ხელოსანი წაიშალა')) { openId = null; showReferrers(); }
  }
  if (action === 'delete-payment' && confirm('წავშალო ეს გადახდა?'))
    act(() => api('DELETE', `/api/payments/${e.target.closest('tr').dataset.payment}`), 'გადახდა წაიშალა');
});
