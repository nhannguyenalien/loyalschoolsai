const NAV = [
  { page: 'customers', href: 'customers.html', icon: 'ti-users', label: 'Khách hàng & điểm' },
  { page: 'rewards', href: 'rewards.html', icon: 'ti-world-star', label: 'Reward World' },
  { page: 'settings', href: 'settings.html', icon: 'ti-settings', label: 'Luật tích điểm' },
];

function renderLayout(active, title) {
  const links = NAV.map(n => `<li class="nav-item"><a class="nav-link ${n.page === active ? 'active' : ''}" href="${n.href}"><span class="nav-link-icon"><i class="ti ${n.icon}"></i></span><span class="nav-link-title">${n.label}</span></a></li>`).join('');
  document.getElementById('layout').innerHTML = `
    <aside class="navbar navbar-vertical navbar-expand-lg" data-bs-theme="dark">
      <div class="container-fluid">
        <button class="navbar-toggler" data-bs-toggle="collapse" data-bs-target="#sidebar-menu"><span class="navbar-toggler-icon"></span></button>
        <h1 class="navbar-brand navbar-brand-autodark"><i class="ti ti-gift me-2"></i>Loyal SchoolsAI</h1>
        <div class="collapse navbar-collapse" id="sidebar-menu">
          <ul class="navbar-nav pt-lg-3">${links}</ul>
          <div class="mt-auto p-3 small text-secondary">
            <div class="text-truncate">${esc(window.AUTH_USER?.email || window.AUTH_USER?.name || '')}</div>
            <button class="btn btn-sm btn-outline-secondary mt-2 w-100" onclick="logout()"><i class="ti ti-logout me-1"></i>Đăng xuất</button>
          </div>
        </div>
      </div>
    </aside>
    <div class="page-wrapper"><main class="page-body"><div class="container-xl">
      <h1 class="page-title mb-4">${esc(title)}</h1><div id="alert"></div><div id="content"></div>
    </div></main></div>`;
}
