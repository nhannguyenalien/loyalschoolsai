/**
 * Client cho API loyalty (Cloudflare Pages Function cùng origin: /api/v1/loyalty/*).
 * Xác thực bằng Firebase ID token của người dùng.
 */
async function loyaltyFetch(path, options = {}) {
  const res = await fetch(`/api/v1/loyalty${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await getIdToken()}`,
      ...(options.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Phiên đăng nhập đã hết hạn.'); }
  if (!res.ok) throw new Error(body.error || `API trả về HTTP ${res.status}`);
  return body;
}

const jsonBody = (method, data) => ({ method, body: JSON.stringify(data) });

const enc = encodeURIComponent;
const games = (path, options) => loyaltyFetch(`/games${path}`, options);

const LoyaltyAPI = {
  // ---- Game giữ chân & quay số
  gameSettings: () => games('/settings'),
  saveGameSettings: data => games('/settings', jsonBody('PUT', data)),
  checkinStatus: ref => games(`/checkin?customer_ref=${enc(ref)}`),
  checkin: ref => games('/checkin', jsonBody('POST', { customer_ref: ref })),
  missions: () => games('/missions'),
  missionBoard: ref => games(`/missions?customer_ref=${enc(ref)}`),
  createMission: data => games('/missions', jsonBody('POST', data)),
  updateMission: (id, data) => games(`/missions/${enc(id)}`, jsonBody('PATCH', data)),
  claimMission: (id, ref) => games(`/missions/${enc(id)}/claim`, jsonBody('POST', { customer_ref: ref })),
  draws: () => games('/draws'),
  createDraw: data => games('/draws', jsonBody('POST', data)),
  updateDraw: (id, data) => games(`/draws/${enc(id)}`, jsonBody('PATCH', data)),
  drawDetail: (id, ref) => games(`/draws/${enc(id)}${ref ? `?customer_ref=${enc(ref)}` : ''}`),
  grantTickets: (id, data) => games(`/draws/${enc(id)}/tickets`, jsonBody('POST', data)),
  runDraw: id => games(`/draws/${enc(id)}/draw`, { method: 'POST' }),
  claimWinner: (id, winnerId) => games(`/draws/${enc(id)}/winners/${enc(winnerId)}/claim`, { method: 'POST' }),

  getProgram: () => loyaltyFetch('/program'),
  saveProgram: data => loyaltyFetch('/program', jsonBody('PUT', data)),
  getAccount: ref => loyaltyFetch(`/account?customer_ref=${encodeURIComponent(ref)}&per_page=100`),
  addSale: data => loyaltyFetch('/sales', jsonBody('POST', data)),
  redeem: data => loyaltyFetch('/redemptions', jsonBody('POST', data)),
  stats: () => loyaltyFetch('/stats'),
  spinsFor: ref => loyaltyFetch(`/reward-world/entitlements?customer_ref=${encodeURIComponent(ref)}`),
  listKeys: () => loyaltyFetch('/api-keys'),
  createKey: name => loyaltyFetch('/api-keys', jsonBody('POST', { name })),
  revokeKey: id => loyaltyFetch(`/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  campaigns: () => loyaltyFetch('/reward-world/campaigns'),
  join: id => loyaltyFetch(`/reward-world/campaigns/${encodeURIComponent(id)}/join`, { method: 'POST' }),
  spin: data => loyaltyFetch('/reward-world/spins', jsonBody('POST', data)),
  rewards: ref => loyaltyFetch(`/reward-world/rewards?customer_ref=${encodeURIComponent(ref)}`),
  claim: (id, note) => loyaltyFetch(`/reward-world/results/${encodeURIComponent(id)}/claim`, jsonBody('POST', { claim_note: note })),
};
