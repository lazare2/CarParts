const MONTHS = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი',
  'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];

const $ = (sel) => document.querySelector(sel);
let parts = [];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gel = (n) => `${n.toLocaleString('ka-GE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ₾`;
const monthLabel = (m) => { const [y, mo] = m.split('-'); return `${MONTHS[Number(mo) - 1]} ${y}`; };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'შეცდომა');
  return data;
}

let messageTimer;
function showMessage(text, ok = true) {
  const el = $('#message');
  el.textContent = text;
  el.className = `message ${ok ? 'ok' : 'err'}`;
  el.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (el.hidden = true), 4000);
}

// run an action, show result, refresh data
async function act(fn, okText) {
  try {
    await fn();
    if (okText) showMessage(okText);
    await refresh();
    return true;
  } catch (err) {
    showMessage(err.message, false);
    return false;
  }
}

// ---------- tabs ----------

document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== btn.dataset.tab));
    if (btn.dataset.tab === 'finance') loadFinance();
  }));

// ---------- ნაწილები ----------

function renderParts() {
  const q = $('#search').value.trim().toLowerCase();
  const list = parts.filter((p) => p.name.toLowerCase().includes(q));
  $('#parts-empty').hidden = parts.length > 0;
  $('#parts-body').innerHTML = list.map((p) => `
    <tr>
      <td>${esc(p.name)}</td>
      <td class="num ${p.quantity === 0 ? 'zero' : ''}">${p.quantity}</td>
      <td class="num"><button class="sell" data-sell="${p.id}" ${p.quantity === 0 ? 'disabled' : ''}>გაყიდვა</button></td>
    </tr>`).join('');
}

$('#search').addEventListener('input', renderParts);

$('#parts-body').addEventListener('click', (e) => {
  const id = e.target.dataset.sell;
  if (id) openSellDialog(parts.find((p) => p.id === Number(id)));
});

function openSellDialog(part) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <form method="dialog">
      <h3>${esc(part.name)} <small>(მარაგში: ${part.quantity})</small></h3>
      <label>რამდენი გაიყიდა
        <input name="quantity" type="number" min="1" max="${part.quantity}" step="1" value="1" required></label>
      <label>რა ჯამურ ფასად გაიყიდა (₾)
        <input name="price" type="number" min="0" step="0.01" required></label>
      <div class="actions">
        <button type="button" class="secondary" value="cancel">გაუქმება</button>
        <button type="submit">გაყიდვა</button>
      </div>
    </form>`;
  document.body.append(dlg);
  const form = dlg.querySelector('form');
  dlg.querySelector('.secondary').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    dlg.close();
    await act(
      () => api('POST', `/api/parts/${part.id}/sell`, { quantity: f.get('quantity'), price: f.get('price') }),
      `გაიყიდა: ${part.name} × ${f.get('quantity')}`);
  });
  dlg.showModal();
  form.quantity.select();
}

// ---------- ფინანსები ----------

async function loadFinance() {
  const months = await api('GET', '/api/finance');
  $('#finance-empty').hidden = months.length > 0;
  $('#finance-body').innerHTML = months.map((m) => {
    const net = m.sold - m.spent;
    return `
    <div class="month">
      <h2>${monthLabel(m.month)}
        <span class="summary">გაყიდვები: <b>${gel(m.sold)}</b> · შესყიდვები: <b>${gel(m.spent)}</b> ·
          სხვაობა: <b class="${net >= 0 ? 'profit' : 'loss'}">${gel(net)}</b></span>
      </h2>
      ${m.sales.length ? `
      <table>
        <thead><tr><th>თარიღი</th><th>ნაწილი</th><th class="num">რაოდენობა</th><th class="num">გაყიდვის ფასი</th></tr></thead>
        <tbody>${m.sales.map((s) => `
          <tr><td>${s.date.split('-').reverse().join('.')}</td><td>${esc(s.name)}</td>
          <td class="num">${s.quantity}</td><td class="num">${gel(s.price)}</td></tr>`).join('')}
        </tbody>
      </table>` : '<p class="empty">ამ თვეში გაყიდვა არ ყოფილა.</p>'}
    </div>`;
  }).join('');
}

// ---------- ადმინი ----------

function renderAdmin() {
  $('#admin-body').innerHTML = parts.map((p) => `
    <tr data-id="${p.id}">
      <td><div class="inline">
        <input class="name" value="${esc(p.name)}" style="width:100%">
        <button class="secondary" data-action="rename">შენახვა</button>
      </div></td>
      <td class="num">${p.quantity}</td>
      <td><div class="inline">
        <input class="add-qty" type="number" min="1" step="1" placeholder="რაოდ.">
        <input class="add-cost" type="number" min="0" step="0.01" placeholder="თანხა ₾">
        <button data-action="add">+</button>
      </div></td>
      <td><div class="inline">
        <input class="set-qty" type="number" min="0" step="1" value="${p.quantity}">
        <button class="secondary" data-action="set">შესწორება</button>
      </div></td>
    </tr>`).join('');
}

$('#admin-body').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  const row = e.target.closest('tr');
  const id = row.dataset.id;
  const val = (sel) => row.querySelector(sel).value;

  if (action === 'rename')
    act(() => api('PATCH', `/api/parts/${id}`, { name: val('.name') }), 'სახელი შეიცვალა');
  if (action === 'add')
    act(() => api('POST', `/api/parts/${id}/add-stock`, { quantity: val('.add-qty'), cost: val('.add-cost') }), 'მარაგი გაიზარდა');
  if (action === 'set')
    act(() => api('POST', `/api/parts/${id}/set-stock`, { quantity: val('.set-qty') }), 'რაოდენობა შესწორდა');
});

$('#new-part').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = Object.fromEntries(new FormData(form));
  if (await act(() => api('POST', '/api/parts', f), `დაემატა: ${f.name}`)) {
    form.reset();
    form.quantity.value = 1;
  }
});

// ---------- start ----------

async function refresh() {
  parts = await api('GET', '/api/parts');
  renderParts();
  renderAdmin();
  if (!$('#finance').hidden) loadFinance();
}

refresh().catch((err) => showMessage(err.message, false));
