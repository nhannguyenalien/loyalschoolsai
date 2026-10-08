/**
 * Client cho API loyalty (Cloudflare Pages Function cùng origin: /api/v1/loyalty/*).
 * Xác thực bằng token PocketBase của người dùng + header X-Tenant.
 */
async function loyaltyFetch(path, options = {}) {
  const res = await fetch(`/api/v1/loyalty${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: PB.authStore.token,
      'X-Tenant': window.TENANT,
      ...(options.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Phiên đăng nhập đã hết hạn.'); }
  if (!res.ok) throw new Error(body.error || `API trả về HTTP ${res.status}`);
  return body;
}

const jsonBody = (method, data) => ({ method, body: JSON.stringify(data) });

const LoyaltyAPI = {
  getProgram: () => loyaltyFetch('/program'),
  saveProgram: data => loyaltyFetch('/program', jsonBody('PUT', data)),
  getAccount: ref => loyaltyFetch(`/account?customer_ref=${encodeURIComponent(ref)}&per_page=100`),
  addSale: data => loyaltyFetch('/sales', jsonBody('POST', data)),
  redeem: data => loyaltyFetch('/redemptions', jsonBody('POST', data)),
  listKeys: () => loyaltyFetch('/api-keys'),
  createKey: name => loyaltyFetch('/api-keys', jsonBody('POST', { name })),
  revokeKey: id => loyaltyFetch(`/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  campaigns: () => loyaltyFetch('/reward-world/campaigns'),
  join: id => loyaltyFetch(`/reward-world/campaigns/${encodeURIComponent(id)}/join`, { method: 'POST' }),
  spin: data => loyaltyFetch('/reward-world/spins', jsonBody('POST', data)),
  rewards: ref => loyaltyFetch(`/reward-world/rewards?customer_ref=${encodeURIComponent(ref)}`),
  claim: (id, note) => loyaltyFetch(`/reward-world/results/${encodeURIComponent(id)}/claim`, jsonBody('POST', { claim_note: note })),
};
