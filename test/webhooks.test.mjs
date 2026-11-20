import test from "node:test";
import assert from "node:assert/strict";
import { attemptDelivery, emitWebhookEvent, signWebhook, validateWebhookUrl } from "../src/webhooks.js";
import { HttpError } from "../src/auth.js";

// Kho giả trong bộ nhớ, đủ cho luồng giao webhook.
function memoryRepo(endpoints) {
  const deliveries = [];
  return {
    deliveries,
    listActiveWebhookEndpoints: async () => endpoints,
    insertWebhookDelivery: async (d) => {
      if (deliveries.some((x) => x.endpoint_id === d.endpointId && x.event_id === d.eventId)) return null;
      const row = { id: crypto.randomUUID(), endpoint_id: d.endpointId, event_id: d.eventId, event_type: d.eventType, payload: d.payload, attempts: 0, status: "pending" };
      deliveries.push(row); return row;
    },
    finishWebhookDelivery: async (id, patch) => Object.assign(deliveries.find((x) => x.id === id), { status: patch.status, attempts: patch.attempts, last_status: patch.lastStatus, delay: patch.delaySeconds }),
  };
}

test("chữ ký HMAC kiểm chứng được phía nhận", async () => {
  const sig = await signWebhook("whsec_x", 1700000000, '{"a":1}');
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(sig, await signWebhook("whsec_x", 1700000000, '{"a":1}'));
  assert.notEqual(sig, await signWebhook("whsec_y", 1700000000, '{"a":1}'));
  assert.notEqual(sig, await signWebhook("whsec_x", 1700000001, '{"a":1}'));
});

test("emit: lọc theo loại sự kiện, ký, đánh dấu success", async () => {
  const repo = memoryRepo([
    { id: "e1", url: "https://a.example/hook", secret: "s1", events: ["points.earned"], active: true },
    { id: "e2", url: "https://b.example/hook", secret: "s2", events: ["reward.won"], active: true },
    { id: "e3", url: "https://c.example/hook", secret: "s3", events: [], active: true },
  ]);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response("ok", { status: 200 }); };
  await emitWebhookEvent({ repository: repo, tenant: "t", type: "points.earned", data: { points: 5 }, fetchImpl });
  assert.deepEqual(calls.map((c) => c.url).sort(), ["https://a.example/hook", "https://c.example/hook"]);
  const { init } = calls[0];
  const [t, v1] = init.headers["x-loyalty-signature"].split(",").map((p) => p.split("=")[1]);
  assert.equal(v1, await signWebhook("s1", t, init.body));
  assert.equal(JSON.parse(init.body).data.points, 5);
  assert.ok(repo.deliveries.every((d) => d.status === "success" && d.attempts === 1));
});

test("thất bại: pending + backoff, đủ 6 lần thì failed", async () => {
  const repo = memoryRepo([]);
  const endpoint = { id: "e1", url: "https://a.example/h", secret: "s", active: true };
  const delivery = await repo.insertWebhookDelivery({ endpointId: "e1", eventId: "ev", eventType: "ping", payload: "{}" });
  const fail = async () => new Response("no", { status: 500 });
  let r = await attemptDelivery({ repository: repo, delivery, endpoint, fetchImpl: fail });
  assert.equal(r.status, "pending"); assert.equal(r.delay, 60); assert.equal(r.last_status, 500);
  for (let i = 0; i < 4; i += 1) r = await attemptDelivery({ repository: repo, delivery, endpoint, fetchImpl: () => { throw new Error("boom"); } });
  assert.equal(r.status, "pending"); assert.equal(r.attempts, 5);
  r = await attemptDelivery({ repository: repo, delivery, endpoint, fetchImpl: fail });
  assert.equal(r.status, "failed"); assert.equal(r.attempts, 6);
});

test("endpoint bị xoá/tắt → failed ngay", async () => {
  const repo = memoryRepo([]);
  const delivery = await repo.insertWebhookDelivery({ endpointId: "x", eventId: "ev", eventType: "ping", payload: "{}" });
  assert.equal((await attemptDelivery({ repository: repo, delivery, endpoint: null })).status, "failed");
});

test("URL: chỉ https công khai", () => {
  assert.equal(validateWebhookUrl("https://shop.example/hook"), "https://shop.example/hook");
  for (const bad of ["http://shop.example", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x", "https://a.internal/x", "https://u:p@shop.example/x", "nonsense"]) {
    assert.throws(() => validateWebhookUrl(bad), HttpError, bad);
  }
});
