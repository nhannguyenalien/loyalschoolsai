const money = new Intl.NumberFormat('vi-VN');
const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmtDate = v => new Date(v).toLocaleString('vi-VN');

function showAlert(message, type = 'success') {
  const el = document.getElementById('alert');
  if (el) el.innerHTML = `<div class="alert alert-${type}" role="alert">${esc(message)}</div>`;
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
