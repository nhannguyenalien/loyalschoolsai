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
  if (res.status === 401) { logout(); throw new Error(T('Your session has expired.', 'Phiên đăng nhập đã hết hạn.')); }
  if (!res.ok) throw new Error(body.error || T(`The API returned HTTP ${res.status}`, `API trả về HTTP ${res.status}`));
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
  // Nhiệm vụ ngày (period = 'day') và thử thách tuần (period = 'week') dùng chung một bộ hàm.
  mission: period => {
    const base = period === 'week' ? '/challenges' : '/missions';
    return {
      list: () => games(base),
      board: ref => games(`${base}?customer_ref=${enc(ref)}`),
      create: data => games(base, jsonBody('POST', data)),
      update: (id, data) => games(`${base}/${enc(id)}`, jsonBody('PATCH', data)),
      claim: (id, ref) => games(`${base}/${enc(id)}/claim`, jsonBody('POST', { customer_ref: ref })),
    };
  },
  // Săn kho báu + quà hiện vật chờ giao
  treasures: () => games('/treasures'),
  createTreasure: data => games('/treasures', jsonBody('POST', data)),
  updateTreasure: (id, data) => games(`/treasures/${enc(id)}`, jsonBody('PATCH', data)),
  redeemTreasure: (ref, code) => games('/treasure/redeem', jsonBody('POST', { customer_ref: ref, code })),
  gifts: status => games(`/gifts${status ? `?status=${enc(status)}` : ''}`),
  deliverGift: id => games(`/gifts/${enc(id)}/deliver`, { method: 'POST' }),
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
  sendEvent: (data, idempotencyKey) => loyaltyFetch('/events', { ...jsonBody('POST', data), headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {} }),
  listWebhooks: () => loyaltyFetch('/webhooks'),
  createWebhook: (url, events) => loyaltyFetch('/webhooks', jsonBody('POST', { url, events })),
  deleteWebhook: id => loyaltyFetch(`/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  toggleWebhook: (id, active) => loyaltyFetch(`/webhooks/${encodeURIComponent(id)}`, jsonBody('PATCH', { active })),
  testWebhook: id => loyaltyFetch(`/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  webhookDeliveries: () => loyaltyFetch('/webhooks/deliveries'),
  storePage: () => loyaltyFetch('/store-page'),
  saveStorePage: data => loyaltyFetch('/store-page', jsonBody('PUT', data)),
  resetCustomerPin: (customer_ref, pin) => loyaltyFetch('/store-page/pin-reset', jsonBody('POST', pin ? { customer_ref, pin } : { customer_ref })),
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

/** Load the store's points rule and remember its currency for formatting amounts. */
async function loadProgram() {
  const { program } = await LoyaltyAPI.getProgram();
  setStoreCurrency(program?.currency || 'USD');
  applyCurrency();
  return program;
}
