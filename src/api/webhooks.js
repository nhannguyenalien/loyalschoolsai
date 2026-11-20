import { HttpError } from "../auth.js";
import {
  assertEndpointQuota, attemptDelivery, generateWebhookSecret, processDueWebhooks, validateWebhookEvents, validateWebhookUrl, WEBHOOK_EVENTS,
} from "../webhooks.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Quản lý webhook của tenant. Chỉ dùng bằng phiên đăng nhập (giống API key). */
export function createWebhooksApi({ repository, fetchImpl }) {
  return async (request, { tenant, via }) => {
    if (via !== "session") throw new HttpError(403, "Webhooks can only be managed from a signed-in session.");
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");
    const base = "/api/v1/loyalty/webhooks";
    const method = request.method;
    if (method === "GET" && path === base) return json(200, { endpoints: await repository.listWebhookEndpoints(tenant), available_events: WEBHOOK_EVENTS });
    if (method === "POST" && path === base) {
      const body = await request.json().catch(() => ({}));
      const target = validateWebhookUrl(body.url);
      const events = validateWebhookEvents(body.events);
      assertEndpointQuota(await repository.countWebhookEndpoints(tenant));
      const secret = generateWebhookSecret();
      return json(201, { endpoint: await repository.createWebhookEndpoint({ tenant, url: target, secret, events }), secret }); // secret chỉ trả lần này
    }
    if (method === "GET" && path === `${base}/deliveries`) {
      return json(200, { deliveries: await repository.listWebhookDeliveries(tenant, { endpointId: url.searchParams.get("endpoint_id") }) });
    }
    if (method === "POST" && path === `${base}/deliveries/retry`) {
      const results = await processDueWebhooks({ repository, tenant, fetchImpl });
      return json(200, { retried: results.length });
    }
    const m = path.match(/^\/api\/v1\/loyalty\/webhooks\/([^/]+)(\/test)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const endpoint = await repository.getWebhookEndpoint(tenant, id);
      if (!endpoint) return json(404, { error: "Webhook endpoint was not found." });
      if (method === "DELETE" && !m[2]) { await repository.deleteWebhookEndpoint(tenant, id); return json(200, { deleted: true }); }
      if (method === "PATCH" && !m[2]) {
        const body = await request.json().catch(() => ({}));
        if (typeof body.active !== "boolean") throw new HttpError(400, "active must be true or false.");
        return json(200, { endpoint: await repository.setWebhookActive(tenant, id, body.active) });
      }
      if (method === "POST" && m[2]) {
        const eventId = crypto.randomUUID();
        const payload = JSON.stringify({ id: eventId, type: "ping", created_at: new Date().toISOString(), data: { message: "Webhook test" } });
        const delivery = await repository.insertWebhookDelivery({ tenant, endpointId: id, eventId, eventType: "ping", payload });
        const result = await attemptDelivery({ repository, delivery, endpoint, fetchImpl });
        return json(200, { status: result.status, http_status: result.last_status, error: result.last_error });
      }
    }
    return null;
  };
}
