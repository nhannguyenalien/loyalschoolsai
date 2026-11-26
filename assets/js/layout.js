const NAV = [
  { page: 'welcome', href: 'welcome.html', icon: 'ti-rocket', label: T('Quick start', 'Bắt đầu nhanh') },
  { page: 'overview', href: 'overview.html', icon: 'ti-layout-dashboard', label: T('Overview', 'Tổng quan') },
  { page: 'customers', href: 'customers.html', icon: 'ti-users', label: T('Customers & points', 'Khách hàng & điểm') },
  { page: 'qr', href: 'qr.html', icon: 'ti-qrcode', label: T('Customer page & QR', 'Trang khách & QR') },
  { page: 'rewards', href: 'rewards.html', icon: 'ti-gift', label: T('Reward spins', 'Quay thưởng') },
  { section: T('Games', 'Trò chơi') },
  { page: 'checkin', href: 'checkin.html', icon: 'ti-calendar-check', label: T('Check-in & streaks', 'Điểm danh & chuỗi') },
  { page: 'missions', href: 'missions.html', icon: 'ti-target-arrow', label: T('Daily missions', 'Nhiệm vụ hằng ngày') },
  { page: 'challenges', href: 'challenges.html', icon: 'ti-trophy', label: T('Weekly challenges', 'Thử thách tuần') },
  { page: 'treasures', href: 'treasures.html', icon: 'ti-diamond', label: T('Treasure hunt', 'Săn kho báu') },
  { page: 'draws', href: 'draws.html', icon: 'ti-ticket', label: T('Lucky draws', 'Quay số may mắn') },
  { section: T('Setup', 'Cấu hình') },
  { page: 'settings', href: 'settings.html', icon: 'ti-adjustments', label: T('Points rule', 'Luật tích điểm') },
  { page: 'integrations', href: 'integrations.html', icon: 'ti-plug-connected', label: T('POS integration', 'Tích hợp POS') },
  { page: 'docs', href: T('docs.html', 'docs-vi.html'), icon: 'ti-book-2', label: T('API docs', 'Tài liệu API'), external: true },
];

function renderLayout(active, title, subtitle = '', actionsHtml = '') {
  const links = NAV.map(n => n.section
    ? `<li class="nav-section">${n.section}</li>`
    : `<li class="nav-item"><a class="nav-link ${n.page === active ? 'active' : ''}" href="${n.href}" ${n.external ? 'target="_blank" rel="noopener"' : ''}><span class="nav-link-icon"><i class="ti ${n.icon}"></i></span><span class="nav-link-title">${n.label}</span>${n.external ? '<i class="ti ti-external-link ms-auto small opacity-50"></i>' : ''}</a></li>`).join('');
  const user = window.AUTH_USER || {};
  document.getElementById('layout').innerHTML = `
    <aside class="navbar navbar-vertical navbar-expand-lg" data-bs-theme="dark">
      <div class="container-fluid">
        <button class="navbar-toggler" data-bs-toggle="collapse" data-bs-target="#sidebar-menu"><span class="navbar-toggler-icon"></span></button>
        <h1 class="navbar-brand navbar-brand-autodark d-flex align-items-center"><span class="brand-mark"><i class="ti ti-gift"></i></span><span class="brand-text">Loyal<br><small>SchoolsAI</small></span></h1>
        <div class="collapse navbar-collapse" id="sidebar-menu">
          <ul class="navbar-nav pt-lg-1">${links}</ul>
          <div class="side-user mt-auto">
            <div class="d-flex align-items-center gap-2 mb-2">
              <span class="avatar avatar-sm avatar-grad rounded-circle">${esc(initials(user.name || user.email))}</span>
              <div class="text-truncate"><div class="email text-truncate">${esc(user.name || user.email || '')}</div><div class="small text-truncate">${esc(user.email && user.name !== user.email ? user.email : T('Your store', 'Cửa hàng của bạn'))}</div></div>
            </div>
            <button class="btn btn-sm w-100 mb-2" style="background:rgba(255,255,255,.1);color:#fff" onclick="logout()"><i class="ti ti-logout me-1"></i>${T('Sign out', 'Đăng xuất')}</button>
            <div class="text-center small">${langSwitchHtml('text-white-50')}</div>
          </div>
        </div>
      </div>
    </aside>
    <div class="page-wrapper"><main class="page-body mt-0 pt-4"><div class="container-xl">
      <div class="page-hero"><div><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>${actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ''}</div>
      <div id="alert"></div><div id="content"></div>
    </div></main></div>`;
}
