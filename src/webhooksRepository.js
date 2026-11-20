/** Truy cập DB cho webhook. `query`/`one` lấy từ neonRepository. */
export function createWebhooksRepository({ query, one }) {
  return {
    countWebhookEndpoints: async (tenant) => Number((await one("SELECT COUNT(*) AS n FROM webhook_endpoints WHERE tenant = $1", [tenant])).n),
    createWebhookEndpoint: ({ tenant, url, secret, events }) => one(
      `INSERT INTO webhook_endpoints (id, tenant, url, secret, events) VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, url, events, active, created_at`, [crypto.randomUUID(), tenant, url, secret, JSON.stringify(events)]),
    listWebhookEndpoints: (tenant) => query(
      "SELECT id, url, events, active, created_at FROM webhook_endpoints WHERE tenant = $1 ORDER BY created_at DESC", [tenant]),
    listActiveWebhookEndpoints: (tenant) => query(
      "SELECT id, url, secret, events FROM webhook_endpoints WHERE tenant = $1 AND active", [tenant]),
    getWebhookEndpoint: (tenant, id) => one("SELECT id, url, secret, events, active FROM webhook_endpoints WHERE tenant = $1 AND id = $2", [tenant, id]),
    getWebhookEndpointById: (id) => one("SELECT id, url, secret, events, active FROM webhook_endpoints WHERE id = $1", [id]),
    setWebhookActive: (tenant, id, active) => one(
      "UPDATE webhook_endpoints SET active = $3 WHERE tenant = $1 AND id = $2 RETURNING id, url, events, active, created_at", [tenant, id, active]),
    deleteWebhookEndpoint: (tenant, id) => one("DELETE FROM webhook_endpoints WHERE tenant = $1 AND id = $2 RETURNING id", [tenant, id]),
    // Tạo lần giao và "thuê" 2 phút để bộ xử lý thử lại không giao trùng lúc lần đầu đang chạy.
    insertWebhookDelivery: ({ tenant, endpointId, eventId, eventType, payload }) => one(
      `INSERT INTO webhook_deliveries (id, tenant, endpoint_id, event_id, event_type, payload, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '2 minutes') ON CONFLICT DO NOTHING RETURNING *`,
      [crypto.randomUUID(), tenant, endpointId, eventId, eventType, payload]),
    claimDueWebhookDeliveries: (tenant, limit) => query(
      `WITH due AS (SELECT id FROM webhook_deliveries WHERE tenant = $1 AND status = 'pending' AND next_attempt_at <= now()
                    ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '2 minutes' FROM due WHERE d.id = due.id RETURNING d.*`, [tenant, limit]),
    finishWebhookDelivery: (id, { status, attempts, delaySeconds = 0, lastStatus = null, lastError = "" }) => one(
      `UPDATE webhook_deliveries SET status = $2, attempts = $3, next_attempt_at = now() + ($4 || ' seconds')::interval,
         last_status = $5, last_error = $6, delivered_at = CASE WHEN $2 = 'success' THEN now() ELSE delivered_at END
       WHERE id = $1 RETURNING *`, [id, status, attempts, String(delaySeconds), lastStatus, String(lastError).slice(0, 300)]),
    listWebhookDeliveries: (tenant, { endpointId, limit = 50 } = {}) => query(
      `SELECT id, endpoint_id, event_id, event_type, status, attempts, last_status, last_error, next_attempt_at, delivered_at, created_at
       FROM webhook_deliveries WHERE tenant = $1 AND ($2::text IS NULL OR endpoint_id = $2) ORDER BY created_at DESC LIMIT $3`,
      [tenant, endpointId || null, limit]),
  };
}
