/**
 * Xác thực người dùng bằng token PocketBase (cùng tài khoản `tenants` ở dashboard chính),
 * và kiểm tra họ có quyền với cửa hàng (tenant) trong header X-Tenant.
 */
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function authenticateTenant(request, env) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Authentication is required.");
  const refreshed = await fetch(`${env.PB_URL}/api/collections/tenants/auth-refresh`, { method: "POST", headers: { Authorization: token } });
  if (!refreshed.ok) throw new HttpError(401, "Session is invalid or expired.");
  const { record } = await refreshed.json();
  const requested = (request.headers.get("x-tenant") || record.tenant || "").trim();
  if (!requested) throw new HttpError(403, "No tenant for this account.");
  if (requested === String(record.tenant || "").trim()) return { tenant: requested, user: record };
  const filter = encodeURIComponent(`account = "${record.id}" && tenant = "${requested.replace(/["\\]/g, "")}" && status = "active"`);
  const membership = await fetch(`${env.PB_URL}/api/collections/tenant_memberships/records?perPage=1&filter=${filter}`, { headers: { Authorization: token } });
  const data = membership.ok ? await membership.json() : { items: [] };
  if (!data.items?.length) throw new HttpError(403, "You do not have access to this tenant.");
  return { tenant: requested, user: record };
}

export function requireAdmin(request, env) {
  const given = request.headers.get("x-admin-secret") || "";
  const secret = env.ADMIN_SECRET || "";
  let diff = given.length ^ secret.length;
  for (let i = 0; i < Math.max(given.length, secret.length); i += 1) diff |= (given.charCodeAt(i) || 0) ^ (secret.charCodeAt(i) || 0);
  if (!secret || diff !== 0) throw new HttpError(401, "Admin secret is invalid.");
}
