const money = new Intl.NumberFormat('vi-VN');
const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmtDate = v => new Date(v).toLocaleString('vi-VN');
const fmtShort = v => new Date(v).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const initials = text => (String(text || '?').trim().split(/\s+/).slice(-2).map(w => w[0]).join('') || '?').toUpperCase();

function showAlert(message, type = 'success') {
  const el = document.getElementById('alert');
  if (!el) return;
  const icon = { success: 'ti-circle-check', danger: 'ti-alert-circle', info: 'ti-info-circle', warning: 'ti-alert-triangle' }[type] || 'ti-info-circle';
  el.innerHTML = `<div class="alert alert-${type} alert-dismissible" role="alert"><i class="ti ${icon} me-2"></i>${esc(message)}<a class="btn-close" data-bs-dismiss="alert"></a></div>`;
}

// Chạy handler của form: khoá nút bấm, bắt lỗi, hiện alert.
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
  const old = button.innerHTML; button.innerHTML = '<i class="ti ti-check me-1"></i>Đã chép';
  setTimeout(() => { button.innerHTML = old; }, 1400);
}
