// ===================== Language (English by default, Vietnamese optional) =====================
const LANG = (() => {
  try {
    const query = new URLSearchParams(location.search).get('lang');
    if (query === 'en' || query === 'vi') localStorage.setItem('ls_lang', query);
    return localStorage.getItem('ls_lang') === 'vi' ? 'vi' : 'en';
  } catch { return 'en'; }
})();
const LOCALE = LANG === 'vi' ? 'vi-VN' : 'en-US';
document.documentElement.lang = LANG;
/** T(english, vietnamese) → the string for the current language. */
const T = (en, vi) => (LANG === 'vi' ? vi : en);

function setLang(lang) {
  try { localStorage.setItem('ls_lang', lang); } catch { /* private mode: ?lang= below still works */ }
  const url = new URL(location.href);
  url.searchParams.set('lang', lang);
  location.replace(url);
}
/** Static markup is written in English; elements carry data-vi / data-vi-placeholder / data-vi-title for Vietnamese. */
function applyI18n(root = document) {
  if (LANG !== 'vi') return;
  root.querySelectorAll('[data-vi]').forEach(el => { el.innerHTML = el.dataset.vi; });
  ['placeholder', 'title'].forEach(attr => root.querySelectorAll(`[data-vi-${attr}]`).forEach(el => el.setAttribute(attr, el.getAttribute(`data-vi-${attr}`))));
  root.querySelectorAll('a[href^="docs.html"]').forEach(a => a.setAttribute('href', a.getAttribute('href').replace('docs.html', 'docs-vi.html')));
}
const langSwitchHtml = (cls = '') => `<a href="#" class="${cls}" data-set-lang="${LANG === 'en' ? 'vi' : 'en'}"><i class="ti ti-language me-1"></i>${LANG === 'en' ? 'Tiếng Việt' : 'English'}</a>`;
document.addEventListener('click', event => {
  const link = event.target.closest('[data-set-lang]');
  if (link) { event.preventDefault(); setLang(link.dataset.setLang); }
});

// ===================== Numbers, dates, currency =====================
const money = new Intl.NumberFormat(LOCALE); // plain numbers (points, counts)
const plural = (n, one, many) => (Math.abs(Number(n)) === 1 ? one : many);
/** "1 point" / "5 points" / "5 điểm" */
const pts = n => `${money.format(n)} ${T(plural(n, 'point', 'points'), 'điểm')}`;

// Amounts are stored in minor units: VND = đồng, USD = cents.
const CURRENCY_DECIMALS = { VND: 0, USD: 2 };
let STORE_CURRENCY = (() => { try { const c = localStorage.getItem('ls_currency'); return c in CURRENCY_DECIMALS ? c : 'USD'; } catch { return 'USD'; } })();
function setStoreCurrency(currency) {
  if (!(currency in CURRENCY_DECIMALS)) return;
  STORE_CURRENCY = currency;
  try { localStorage.setItem('ls_currency', currency); } catch { /* cache only */ }
}
const decimalsOf = currency => CURRENCY_DECIMALS[currency] ?? 0;
const toMinor = (major, currency = STORE_CURRENCY) => Math.round(Number(major) * 10 ** decimalsOf(currency));
const toMajor = (minor, currency = STORE_CURRENCY) => Number(minor) / 10 ** decimalsOf(currency);
const fmtMoney = (minor, currency = STORE_CURRENCY) => {
  const code = currency in CURRENCY_DECIMALS ? currency : 'VND';
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol', maximumFractionDigits: decimalsOf(code) }).format(toMajor(minor, code));
};
const currencySymbol = (currency = STORE_CURRENCY) => (currency === 'USD' ? '$' : '₫');
/** Fill every [data-cur] label with the store's currency symbol, and make [data-money] inputs accept its decimals. */
function applyCurrency(root = document) {
  root.querySelectorAll('[data-cur]').forEach(el => { el.textContent = currencySymbol(); });
  root.querySelectorAll('input[data-money]').forEach(el => {
    const unit = decimalsOf(STORE_CURRENCY) ? '0.01' : '1';
    el.step = unit;
    if (Number(el.min) > 0) el.min = unit; // the browser measures steps from min, so it must be a whole unit
  });
}

const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmtDate = v => new Date(v).toLocaleString(LOCALE);
const fmtDay = v => new Date(v).toLocaleDateString(LOCALE);
const fmtShort = v => new Date(v).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const initials = text => (String(text || '?').trim().split(/\s+/).slice(-2).map(w => w[0]).join('') || '?').toUpperCase();

/** Customer-facing links must use the stable production host, not a per-deployment preview host. */
const publicOrigin = () => location.origin.replace(/\/\/[0-9a-f]{8}\.([^/]+\.pages\.dev)/, '//$1');

function showAlert(message, type = 'success') {
  const el = document.getElementById('alert');
  if (!el) return;
  const icon = { success: 'ti-circle-check', danger: 'ti-alert-circle', info: 'ti-info-circle', warning: 'ti-alert-triangle' }[type] || 'ti-info-circle';
  el.innerHTML = `<div class="alert alert-${type} alert-dismissible" role="alert"><i class="ti ${icon} me-2"></i>${esc(message)}<a class="btn-close" data-bs-dismiss="alert"></a></div>`;
}

// Run a form handler: disable the submit button, catch errors, show them.
function onSubmit(formId, handler) {
  document.getElementById(formId).addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter; if (button) button.disabled = true;
    try { await handler(event); } catch (error) { showAlert(error.message, 'danger'); }
    finally { if (button) button.disabled = false; }
  });
}

async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); } catch { return; }
  if (!button) return;
  const old = button.innerHTML; button.innerHTML = `<i class="ti ti-check me-1"></i>${T('Copied', 'Đã chép')}`;
  setTimeout(() => { button.innerHTML = old; }, 1400);
}
