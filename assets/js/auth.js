/**
 * Đăng nhập bằng tài khoản `tenants` của PocketBase (cùng tài khoản dashboard).
 * Sau requireAuth(): window.TENANT, window.AUTH_USER.
 */
const TENANT_KEY = uid => `loyalschoolsai.activeTenant.${uid}`;

async function resolveTenant(user) {
  const legacy = String(user?.tenant || '').trim();
  let list = [];
  try {
    const rows = await PB.collection('tenant_memberships').getFullList({
      filter: `account = "${user.id}" && status = "active"`, sort: '-is_default,tenant'
    });
    list = rows.map(r => ({ tenant: String(r.tenant || '').trim(), isDefault: !!r.is_default }));
  } catch { /* collection chưa migrate: dùng tenant cũ */ }
  if (legacy && !list.some(m => m.tenant === legacy)) list.push({ tenant: legacy, isDefault: true });
  const seen = new Set();
  list = list.filter(m => m.tenant && !seen.has(m.tenant) && seen.add(m.tenant));
  const saved = localStorage.getItem(TENANT_KEY(user.id));
  const active = list.find(m => m.tenant === saved) || list.find(m => m.isDefault) || list[0];
  window.TENANT_LIST = list.map(m => m.tenant);
  window.TENANT = active?.tenant || '';
  if (active) localStorage.setItem(TENANT_KEY(user.id), active.tenant);
  return window.TENANT;
}

function switchTenant(tenant) {
  if (!window.TENANT_LIST.includes(tenant) || tenant === window.TENANT) return;
  localStorage.setItem(TENANT_KEY(PB.authStore.model.id), tenant);
  location.reload(); // xoá toàn bộ state của tenant cũ
}

async function requireAuth() {
  if (!PB.authStore.isValid) return redirectToLogin();
  try { await PB.collection('tenants').authRefresh(); }
  catch (err) {
    // Chỉ đăng xuất khi token sai/hết hạn; lỗi mạng thì giữ session.
    if (err.status === 400 || err.status === 401) { PB.authStore.clear(); return redirectToLogin(); }
  }
  const user = PB.authStore.model;
  if (!user || !(await resolveTenant(user))) { PB.authStore.clear(); return redirectToLogin(); }
  window.AUTH_USER = user;
}

async function loginWithPassword(email, password) {
  await PB.collection('tenants').authWithPassword(email, password);
  if (!(await resolveTenant(PB.authStore.model))) {
    PB.authStore.clear();
    throw new Error('Tài khoản chưa được cấp tenant.');
  }
  location.href = 'customers.html';
}

function logout() { PB.authStore.clear(); redirectToLogin(); }
function redirectToLogin() { location.href = 'index.html'; }
