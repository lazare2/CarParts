// ფინანსები: per month sales (as receipts), returns, commissions and containers bought
import {
  $, esc, gel, fmt, dateLabel, monthLabel, today, api, act, onRefresh, visible, openDialog, stat, moneyField, readMoney, moneyLabel,
} from './core.js';

let data = null;

export async function showFinance() {
  if (!visible('finance')) return;
  data = await api('GET', '/api/finance');
  const t = data.totals;
  $('#finance-totals').innerHTML = data.months.length
    ? stat('სულ გაყიდვები', gel(t.sales)) + stat('დაბრუნებები', gel(t.refunds)) + stat('ხელოსნების საკომისიო', gel(t.commissions)) +
      stat('კონტეინერები', gel(t.containers)) + stat('შედეგი', gel(t.result), t.result >= 0 ? 'good' : 'warn')
    : '';
  $('#finance-empty').hidden = data.months.length > 0;
  $('#finance-body').innerHTML = data.months.map(renderMonth).join('');
}
onRefresh(showFinance);

function renderMonth(m) {
  return `
    <section class="month">
      <h2>${monthLabel(m.month)}</h2>
      <div class="stats small">
        ${stat('გაყიდვები', gel(m.sales))}
        ${stat('დაბრუნებები', gel(m.refunds))}
        ${stat('საკომისიო', gel(m.commissions))}
        ${stat('კონტეინერები', gel(m.containers))}
        ${stat('შედეგი', gel(m.result), m.result >= 0 ? 'good' : 'warn')}
      </div>
      ${m.paid_referrers ? `<p class="hint">ამ თვეში ხელოსნებს გადაეხადა: ${gel(m.paid_referrers)}</p>` : ''}

      ${m.receipts.map(renderReceipt).join('')}

      ${m.returns.length ? `
        <h3>დაბრუნებები</h3>
        <table>
          <thead><tr><th>თარიღი</th><th>ნაწილი</th><th class="num">რაოდ.</th><th>მდგომარეობა</th><th class="num">დაბრუნებული თანხა</th><th>შენიშვნა</th></tr></thead>
          <tbody>${m.returns.map((r) => `
            <tr><td>${dateLabel(r.date)}</td><td>${esc(r.label)} <span class="muted">(გაიყიდა ${dateLabel(r.sale_date)})</span></td>
              <td class="num">${r.quantity}</td><td>${r.condition === 'damaged' ? '<span class="tag bad">დაზიანებული</span>' : 'კარგი'}</td>
              <td class="num">${gel(r.refund_gel)}</td><td>${esc(r.note)}</td></tr>`).join('')}
          </tbody>
        </table>` : ''}

      ${m.arrived.length ? `
        <h3>ჩამოსული კონტეინერები</h3>
        <table>
          <tbody>${m.arrived.map((c) => `
            <tr><td>${dateLabel(c.arrival_date)}</td><td>${esc(c.name)}</td>
              <td class="num">${moneyLabel(c.cost_gel, c.cost_amount, c.cost_currency, c.cost_rate)}</td></tr>`).join('')}
          </tbody>
        </table>` : ''}
    </section>`;
}

function renderReceipt(r) {
  const hasReturns = r.items.some((i) => i.returned_qty > 0);
  return `
    <div class="receipt" data-sale="${r.id}">
      <div class="receipt-head">
        <b>${dateLabel(r.date)}</b>
        <span>${r.referrer ? `ხელოსანი: <b>${esc(r.referrer)}</b>` : '<span class="muted">ჩვეულებრივი გაყიდვა</span>'}</span>
        ${r.currency === 'USD' ? `<span class="muted">გადახდა $-ში, კურსი ${fmt(r.rate)}</span>` : ''}
        <span class="grow"></span>
        <span>სულ: <b>${gel(r.total)}</b>${r.commission ? ` · საკომისიო: ${gel(r.commission)}` : ''}</span>
        ${hasReturns ? '' : '<button class="sm danger" data-action="cancel" title="შეცდომით შეყვანილი გაყიდვის გაუქმება">გაუქმება</button>'}
      </div>
      <table>
        <tbody>${r.items.map((i) => `
          <tr data-item="${i.id}">
            <td>${esc(i.label)} <span class="muted">· ${esc(i.container)}</span>${i.damaged ? ' <span class="tag bad">დაზიანებული</span>' : ''}</td>
            <td class="num">${i.quantity} ც.</td>
            <td class="num">${gel(i.price_gel)}</td>
            <td class="num">${r.referrer ? `${fmt(i.commission_pct)}% = ${gel(i.commission_gel)}` : ''}</td>
            <td class="num">${i.returned_qty ? `<span class="tag">დაბრუნდა ${i.returned_qty} ც. (${gel(i.refunded_gel)})</span>` : ''}</td>
            <td>${i.returned_qty < i.quantity ? '<button class="sm secondary" data-action="return">დაბრუნება</button>' : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

$('#finance-body').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action || !data) return;
  const saleId = Number(e.target.closest('[data-sale]').dataset.sale);
  const receipt = data.months.flatMap((m) => m.receipts).find((r) => r.id === saleId);
  if (action === 'cancel' && confirm('გავაუქმო ეს გაყიდვა? ნაწილები მარაგში დაბრუნდება.'))
    act(() => api('DELETE', `/api/sales/${saleId}`), 'გაყიდვა გაუქმდა, ნაწილები მარაგში დაბრუნდა');
  if (action === 'return') returnDialog(receipt, receipt.items.find((i) => i.id === Number(e.target.closest('tr').dataset.item)));
});

function returnDialog(receipt, item) {
  const left = item.quantity - item.returned_qty;
  const unitPrice = item.price_gel / item.quantity;
  const form = openDialog({
    title: `${esc(item.label)} — დაბრუნება`,
    body: `
      <p class="hint">გაიყიდა ${dateLabel(receipt.date)}: ${item.quantity} ც., ${gel(item.price_gel)}${receipt.referrer ? ` (ხელოსანი: ${esc(receipt.referrer)}, ${fmt(item.commission_pct)}%)` : ''}.</p>
      <label>რამდენი ცალი დაბრუნდა <input name="quantity" type="number" min="1" max="${left}" step="1" value="${left}" required></label>
      <fieldset class="radios"><legend>მდგომარეობა</legend>
        <label class="check"><input type="radio" name="condition" value="damaged" checked> დაზიანებული (მარაგში არ გამოჩნდება)</label>
        <label class="check"><input type="radio" name="condition" value="good"> კარგი (ბრუნდება მარაგში)</label>
      </fieldset>
      ${moneyField('refund', 'მყიდველს დაუბრუნდა', { amount: Math.round(unitPrice * left * 100) / 100 })}
      ${receipt.referrer ? '<p class="hint">ხელოსნის საკომისიო ავტომატურად შემცირდება დაბრუნებული თანხის შესაბამისად.</p>' : ''}
      <label>თარიღი <input name="date" type="date" value="${today()}" required></label>
      <label>შენიშვნა <input name="note" placeholder="მაგ. ბზარი კორპუსზე"></label>`,
    submit: 'დაბრუნების ჩაწერა',
    async onSubmit(f) {
      await api('POST', `/api/sale-items/${item.id}/return`, {
        quantity: f.elements.quantity.value, condition: f.elements.condition.value,
        refund: readMoney(f, 'refund'), date: f.elements.date.value, note: f.elements.note.value,
      });
      return 'დაბრუნება ჩაიწერა';
    },
  });
  // suggest the refund for the chosen quantity
  form.elements.quantity.addEventListener('input', () => {
    if (form.elements.refund_currency.value === 'GEL')
      form.elements.refund_amount.value = Math.round(unitPrice * Number(form.elements.quantity.value || 0) * 100) / 100;
  });
}
