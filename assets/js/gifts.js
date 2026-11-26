/** Bảng "Quà chờ giao": phiếu quà hiện vật từ nhiệm vụ / thử thách / kho báu, nhân viên bấm "Đã giao" khi trao cho khách. */
const GIFT_SOURCES = { mission: T('Daily mission', 'Nhiệm vụ ngày'), challenge: T('Weekly challenge', 'Thử thách tuần'), treasure: T('Treasure', 'Kho báu') };

function mountGiftsPanel(container) {
  container.innerHTML = `<section class="card"><div class="card-header"><h3 class="card-title"><i class="ti ti-package me-2"></i>${T('Gifts to hand out', 'Quà chờ giao')} <span class="badge bg-orange-lt text-orange ms-1 d-none" id="gift-count"></span></h3></div><div class="card-body py-2" id="gift-list"><div class="text-secondary py-3">${T('Loading...', 'Đang tải...')}</div></div></section>`;
  const list = container.querySelector('#gift-list'), count = container.querySelector('#gift-count');
  async function load() {
    try {
      const { gifts } = await LoyaltyAPI.gifts('pending');
      count.textContent = gifts.length; count.classList.toggle('d-none', !gifts.length);
      list.innerHTML = gifts.map(g => `<div class="activity"><span class="avatar avatar-sm tone-amber rounded-circle"><i class="ti ti-gift"></i></span>
        <div class="me-auto" style="min-width:0"><div class="fw-bold text-truncate">${esc(g.label)}</div><div class="small text-secondary">${esc(g.customer_ref)} · ${esc(GIFT_SOURCES[g.source_type] || g.source_type)} · ${esc(fmtShort(g.created_at))}</div></div>
        <button class="btn btn-sm btn-warning deliver" data-id="${esc(g.id)}">${T('Delivered', 'Đã giao')}</button></div>`).join('')
        || `<div class="empty-state py-3"><i class="ti ti-package-off"></i>${T('No gifts waiting to be handed out.', 'Không có quà nào đang chờ giao.')}</div>`;
    } catch (e) { list.innerHTML = `<div class="text-danger">${esc(e.message)}</div>`; }
  }
  list.addEventListener('click', async e => {
    const b = e.target.closest('.deliver'); if (!b) return;
    b.disabled = true;
    try { await LoyaltyAPI.deliverGift(b.dataset.id); showAlert(T('Gift marked as delivered.', 'Đã ghi nhận giao quà.')); await load(); }
    catch (err) { showAlert(err.message, 'danger'); b.disabled = false; }
  });
  load();
  return { reload: load };
}
