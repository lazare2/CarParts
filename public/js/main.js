import { $$, refresh, showMessage } from './core.js';
import './shop.js';
import './admin.js';
import { showStock } from './inventory.js';
import { showReferrers } from './referrers.js';
import { showFinance } from './finance.js';

// views that load their own data when opened
const loaders = { stock: showStock, referrers: showReferrers, finance: showFinance };

$$('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.panel').forEach((p) => (p.hidden = p.id !== btn.dataset.tab));
    loaders[btn.dataset.tab]?.().catch((err) => showMessage(err.message, false));
  }));

refresh().catch((err) => showMessage(err.message, false));
