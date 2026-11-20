import { HttpError } from "./auth.js";

export const WEBHOOK_EVENTS = ["points.earned", "points.redeemed", "checkin.completed", "spin.issued", "reward.won", "ping"];
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600]; // sau lần thử 1..5; lần thứ 6 thất bại là dừng hẳn
const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
const MAX_ENDPOINTS = 5;

export const generateWebhookSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `whsec_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
};

const PRIVATE_HOST = /^(localhost|.*\.(local|internal|localhost)|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[.*\])/i;
export function validateWebhookUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { throw new HttpError(400, "url must be a valid URL."); }
  if (u.protocol !== "https:") throw new HttpError(400, "url must use https.");
  if (u.username || u.password) throw new HttpError(400, "url must not contain credentials.");
  if (PRIVATE_HOST.test(u.hostname)) throw new HttpError(400, "url must be a public host.");
  return u.toString();
}

export function validateWebhookEvents(events) {
  if (events === undefined || events === null) return [];
  if (!Array.isArray(events) || events.some((e) => !WEBHOOK_EVENTS.includes(e))) {
    throw new HttpError(400, `events must be a list of: ${WEBHOOK_EVENTS.join(", ")}.`);
  }
  return [...new Set(events)];
}

export function assertEndpointQuota(count) {
  if (count >= MAX_ENDPOINTS) throw new HttpError(400, `At most ${MAX_ENDPOINTS} webhook endpoints per store.`);
}

/** Chữ ký: HMAC-SHA256 hex của `${timestamp}.${body}`. Header: `t=<unix>,v1=<hex>`. */
export async function signWebhook(secret, timestamp, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Gọi tới endpoint một lần và ghi kết quả. Không bao giờ ném lỗi. */
export async function attemptDelivery({ repository, delivery, endpoint, fetchImpl = fetch }) {
  const attempts = Number(delivery.attempts) + 1;
  if (!endpoint || !endpoint.active) {
    return repository.finishWebhookDelivery(delivery.id, { status: "failed", attempts, lastError: "Endpoint was removed or disabled." });
  }
  const ts = Math.floor(Date.now() / 1000);
  let lastStatus = null, lastError = "";
  try {
    const res = await fetchImpl(endpoint.url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: {
        "content-type": "application/json", "user-agent": "LoyalSchools-Webhooks/1",
        "x-loyalty-event": delivery.event_type, "x-loyalty-delivery": delivery.id,
        "x-loyalty-signature": `t=${ts},v1=${await signWebhook(endpoint.secret, ts, delivery.payload)}`,
      },
      body: delivery.payload,
    });
    lastStatus = res.status;
    if (res.status >= 200 && res.status < 300) return repository.finishWebhookDelivery(delivery.id, { status: "success", attempts, lastStatus });
    lastError = `HTTP ${res.status}`;
  } catch (error) {
    lastError = error?.name === "TimeoutError" ? "Timeout after 5s" : String(error?.message || error);
  }
  const final = attempts >= MAX_ATTEMPTS;
  return repository.finishWebhookDelivery(delivery.id, {
    status: final ? "failed" : "pending", attempts, delaySeconds: final ? 0 : BACKOFF_SECONDS[attempts - 1], lastStatus, lastError,
  });
}

/** Tạo lần giao cho mọi endpoint đăng ký sự kiện này rồi giao ngay. */
export async function emitWebhookEvent({ repository, tenant, type, data, fetchImpl }) {
  const endpoints = (await repository.listActiveWebhookEndpoints(tenant))
    .filter((e) => !e.events?.length || e.events.includes(type));
  if (!endpoints.length) return [];
  const eventId = crypto.randomUUID();
  const payload = JSON.stringify({ id: eventId, type, created_at: new Date().toISOString(), data });
  return Promise.all(endpoints.map(async (endpoint) => {
    const delivery = await repository.insertWebhookDelivery({ tenant, endpointId: endpoint.id, eventId, eventType: type, payload });
    return delivery ? attemptDelivery({ repository, delivery, endpoint, fetchImpl }) : null;
  }));
}

/** Giao lại các lần đến hạn (gọi cơ hội sau mỗi sự kiện, hoặc thủ công qua API). */
export async function processDueWebhooks({ repository, tenant, limit = 10, fetchImpl }) {
  const due = await repository.claimDueWebhookDeliveries(tenant, limit);
  return Promise.all(due.map(async (delivery) =>
    attemptDelivery({ repository, delivery, endpoint: await repository.getWebhookEndpointById(delivery.endpoint_id), fetchImpl })));
}
