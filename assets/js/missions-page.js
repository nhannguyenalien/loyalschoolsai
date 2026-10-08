/**
 * Trang nhiệm vụ dùng chung cho "Nhiệm vụ hằng ngày" (period = 'day') và "Thử thách tuần" (period = 'week').
 * Cả hai chạy trên cùng một động cơ phía máy chủ; khác nhau ở kỳ tính tiến độ (hôm nay / thứ Hai–Chủ nhật, giờ VN).
 */
async function initMissionsPage(cfg) {
  await requireAuth();
  const weekly = cfg.period === 'week';
  renderLayout(cfg.page, cfg.title, cfg.subtitle);
  document.getElementById('content').innerHTML = `
  <div class="row row-cards">
    <div class="col-lg-7">
      <section class="card mb-3"><div class="card-body">
        <div class="fw-bold mb-2">${weekly ? 'Thử thách tuần này của khách' : 'Nhiệm vụ hôm nay của khách'}</div>
        <form id="customer-form" class="input-group mb-3"><input id="customer-ref" class="form-control form-control-lg" placeholder="Số điện thoại / mã khách" required inputmode="tel"><button class="btn btn-primary" type="submit"><i class="ti ti-search me-1"></i>Xem</button></form>
        <div id="board"><div class="empty-state"><i class="ti ${cfg.icon}"></i>Nhập số điện thoại để xem tiến độ.</div></div>
      </div></section>
      <div id="gifts"></div>
    </div>
    <div class="col-lg-5">
      <section class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-list-check me-2"></i>${weekly ? 'Danh sách thử thách' : 'Danh sách nhiệm vụ'}</h3></div><div class="card-body py-2" id="mission-list"><div class="text-secondary py-3">Đang tải...</div></div></section>
      <section class="card"><div class="card-header"><h3 class="card-title"><i class="ti ti-plus me-2"></i>${weekly ? 'Thêm thử thách' : 'Thêm nhiệm vụ'}</h3></div>
        <form class="card-body" id="mission-form">
          <div class="mb-3"><label class="form-label">Tên</label><input id="m-name" class="form-control" maxlength="120" required placeholder="${weekly ? 'Ví dụ: Điểm danh 5 ngày trong tuần' : 'Ví dụ: Mua hàng hôm nay'}"></div>
          <div class="row g-3 mb-3">
            <div class="col-12"><label class="form-label">Điều kiện</label><select id="m-kind" class="form-select">
              <option value="checkin">${weekly ? 'Số ngày điểm danh trong tuần' : 'Điểm danh hôm nay'}</option>
              <option value="receipts">${weekly ? 'Số hóa đơn trong tuần' : 'Số hóa đơn trong ngày'}</option>
              <option value="spend">${weekly ? 'Tổng chi tiêu trong tuần' : 'Tổng chi tiêu trong ngày'}</option></select></div>
            <div class="col-12" id="target-wrap"><label class="form-label" id="target-label">Mục tiêu</label><input id="m-target" class="form-control" type="number" min="1" value="${weekly ? 5 : 1}"></div>
          </div>
          <div class="row g-3 mb-3">
            <div class="col-12"><label class="form-label">Phần thưởng</label><select id="m-reward" class="form-select"><option value="points">Điểm thưởng</option><option value="spin">Lượt chơi (lượt quay)</option><option value="gift">Quà hiện vật (nhân viên giao)</option></select></div>
            <div class="col-12" id="reward-points-wrap"><label class="form-label">Số điểm</label><input id="m-points" class="form-control" type="number" min="1" value="${weekly ? 50 : 10}"></div>
            <div class="col-12 d-none" id="reward-campaign-wrap"><label class="form-label">Chương trình quay</label><select id="m-campaign" class="form-select"></select></div>
            <div class="col-12 d-none" id="reward-label-wrap"><label class="form-label">Tên quà</label><input id="m-label" class="form-control" maxlength="120" placeholder="Ví dụ: Túi vải, Voucher 50k"></div>
          </div>
          <button class="btn btn-grad w-100" type="submit"><i class="ti ti-plus me-1"></i>${weekly ? 'Thêm thử thách' : 'Thêm nhiệm vụ'}</button>
          <div class="form-hint mt-2">${weekly ? 'Kỳ thử thách tính từ thứ Hai đến Chủ nhật (giờ Việt Nam), tự làm mới mỗi tuần.' : 'Tiến độ tính theo ngày (giờ Việt Nam), tự làm mới mỗi ngày.'} Lượt quay dùng ở trang <a href="rewards.html">Quay thưởng</a> (cửa hàng cần đã tham gia chương trình đó).</div>
        </form></section>
    </div>
  </div>`;
  const $ = id => document.getElementById(id);
  const api = LoyaltyAPI.mission(cfg.period);
  const gifts = mountGiftsPanel($('gifts'));
  let customer = null;
  const KIND = { checkin: ['ti-calendar-check'], receipts: ['ti-receipt-2'], spend: ['ti-coins'] };
  const rewardText = m => m.reward_type === 'points' ? `+${money.format(m.reward_points)} điểm` : m.reward_type === 'spin' ? '🎁 1 lượt chơi' : `🎀 ${m.reward_label || 'Quà'}`;
  const targetText = m => m.kind === 'checkin' ? (weekly ? `Điểm danh ${m.target} ngày` : 'Điểm danh hôm nay') : m.kind === 'receipts' ? `${m.target} hóa đơn` : `Chi ${money.format(m.target)} ₫`;

  async function loadMissions() {
    const { missions } = await api.list();
    $('mission-list').innerHTML = missions.map(m => `<div class="activity"><span class="avatar avatar-sm ${m.status === 'active' ? 'tone-indigo' : ''} rounded-circle"><i class="ti ${KIND[m.kind][0]}"></i></span>
      <div class="me-auto" style="min-width:0"><div class="fw-bold text-truncate">${esc(m.name)}</div><div class="small text-secondary">${esc(targetText(m))} → ${esc(rewardText(m))}${m.status === 'paused' ? ' · <b>đang tạm dừng</b>' : ''}</div></div>
      <div class="btn-list flex-nowrap"><button class="btn btn-sm btn-outline-secondary mission-toggle" data-id="${esc(m.id)}" data-status="${m.status === 'active' ? 'paused' : 'active'}">${m.status === 'active' ? 'Tạm dừng' : 'Bật lại'}</button><button class="btn btn-sm btn-outline-danger mission-delete" data-id="${esc(m.id)}" title="Xóa"><i class="ti ti-trash"></i></button></div></div>`).join('')
      || `<div class="empty-state py-3"><i class="ti ${cfg.icon}"></i>Chưa có gì. Thêm ${weekly ? 'thử thách' : 'nhiệm vụ'} đầu tiên bên dưới.</div>`;
  }
  $('mission-list').addEventListener('click', async e => {
    const t = e.target.closest('.mission-toggle'), d = e.target.closest('.mission-delete');
    try {
      if (t) await api.update(t.dataset.id, { status: t.dataset.status });
      else if (d) { if (!confirm('Xóa mục này? Lịch sử nhận thưởng vẫn được giữ.')) return; await api.update(d.dataset.id, { status: 'archived' }); }
      else return;
      await loadMissions(); if (customer) await showBoard(customer);
    } catch (err) { showAlert(err.message, 'danger'); }
  });

  function syncForm() {
    const kind = $('m-kind').value, reward = $('m-reward').value;
    $('target-wrap').classList.toggle('d-none', kind === 'checkin' && !weekly);
    $('target-label').textContent = kind === 'checkin' ? 'Số ngày điểm danh (1–7)' : kind === 'receipts' ? 'Số hóa đơn' : 'Số tiền (₫)';
    if (kind === 'spend' && Number($('m-target').value) < 1000) $('m-target').value = weekly ? 500000 : 100000;
    if (kind === 'receipts' && Number($('m-target').value) > 100) $('m-target').value = weekly ? 3 : 1;
    if (kind === 'checkin' && weekly && Number($('m-target').value) > 7) $('m-target').value = 5;
    $('reward-points-wrap').classList.toggle('d-none', reward !== 'points');
    $('reward-campaign-wrap').classList.toggle('d-none', reward !== 'spin');
    $('reward-label-wrap').classList.toggle('d-none', reward !== 'gift');
  }
  ['m-kind', 'm-reward'].forEach(id => $(id).addEventListener('change', syncForm));
  onSubmit('mission-form', async () => {
    const reward = $('m-reward').value;
    if (reward === 'spin' && !$('m-campaign').value) throw new Error('Chưa có chương trình quay nào cửa hàng đã tham gia. Hãy tham gia ở trang Quay thưởng trước.');
    await api.create({
      name: $('m-name').value.trim(), kind: $('m-kind').value, target: Number($('m-target').value || 1), reward_type: reward,
      ...(reward === 'points' ? { reward_points: Number($('m-points').value) } : reward === 'spin' ? { reward_campaign_id: $('m-campaign').value } : { reward_label: $('m-label').value.trim() }),
    });
    $('m-name').value = ''; showAlert(weekly ? 'Đã thêm thử thách.' : 'Đã thêm nhiệm vụ.'); await loadMissions(); if (customer) await showBoard(customer);
  });

  function renderBoard(board) {
    const fmt = d => `${d.slice(8)}/${d.slice(5, 7)}`;
    const periodLabel = weekly ? `<div class="small text-secondary mb-2"><i class="ti ti-calendar me-1"></i>Tuần ${fmt(board.period_start)} – ${fmt(board.period_end)}</div>` : '';
    $('board').innerHTML = periodLabel + (board.missions.map(m => {
      const pct = Math.min(100, Math.round(m.current / m.target * 100));
      return `<div class="activity"><span class="avatar avatar-md ${m.claimed ? 'tone-green' : m.completed ? 'tone-amber' : 'tone-indigo'} rounded-circle"><i class="ti ${m.claimed ? 'ti-circle-check' : KIND[m.kind][0]}"></i></span>
        <div class="me-auto" style="min-width:0"><div class="fw-bold">${esc(m.name)} <span class="pill" style="background:#f3ecff;color:#6d28d9">${esc(rewardText(m))}</span></div>
          <div class="progress progress-sm my-1" style="max-width:260px"><div class="progress-bar ${m.completed ? 'bg-success' : ''}" style="width:${pct}%"></div></div>
          <div class="small text-secondary">${m.kind === 'spend' ? `${money.format(m.current)} / ${money.format(m.target)} ₫` : m.kind === 'checkin' && weekly ? `${m.current} / ${m.target} ngày` : `${m.current} / ${m.target}`}</div></div>
        ${m.claimed ? '<span class="pill pill-earn">Đã nhận</span>' : m.completed ? `<button class="btn btn-grad btn-sm claim" data-id="${esc(m.id)}">Nhận thưởng</button>` : '<span class="text-secondary small">Chưa xong</span>'}</div>`;
    }).join('') || `<div class="empty-state"><i class="ti ${cfg.icon}"></i>Chưa có ${weekly ? 'thử thách' : 'nhiệm vụ'} nào đang bật.</div>`);
  }
  async function showBoard(ref) { customer = ref; renderBoard(await api.board(ref)); }
  onSubmit('customer-form', () => showBoard($('customer-ref').value.trim()));
  $('board').addEventListener('click', async e => {
    const b = e.target.closest('.claim'); if (!b) return;
    b.disabled = true;
    try {
      const r = await api.claim(b.dataset.id, customer);
      showAlert(r.replayed ? 'Khách đã nhận phần thưởng này rồi.'
        : r.reward.type === 'points' ? `Đã cộng ${r.reward.points} điểm. Số dư: ${money.format(r.balance)} điểm.`
        : r.reward.type === 'spin' ? 'Đã cấp 1 lượt chơi cho khách 🎁'
        : `Đã tạo phiếu quà "${r.reward.label}" — nhớ giao cho khách.`);
      if (!r.replayed && r.reward.type === 'gift') launchConfetti(1600);
      await showBoard(customer); gifts.reload();
    } catch (err) { showAlert(err.message, 'danger'); b.disabled = false; }
  });

  try {
    await loadMissions();
    const world = await LoyaltyAPI.campaigns();
    $('m-campaign').innerHTML = world.campaigns.filter(c => c.joined).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('') || '<option value="">(chưa tham gia chương trình nào)</option>';
  } catch (e) { showAlert(e.message, 'danger'); }
  syncForm();
}
