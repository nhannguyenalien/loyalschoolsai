import test from "node:test";
import assert from "node:assert/strict";
import { neon } from "@neondatabase/serverless";
import { onRequest } from "../functions/api/v1/[[path]].js";

const url = process.env.DATABASE_URL;
const tenant = `test-${crypto.randomUUID().slice(0, 8)}`;
const env = { DATABASE_URL: url, PB_URL: "http://invalid.local", ADMIN_SECRET: "x" };
const call = (path, { key, method = "GET", body } = {}) => onRequest({
  env, request: new Request(`http://t${path}`, { method, body: body && JSON.stringify(body), headers: { ...(key ? { authorization: `Bearer ${key}` } : {}) } }),
});

test("API key cho POS", { skip: !url && "DATABASE_URL not set" }, async (t) => {
  const sql = neon(url);
  t.after(async () => {
    for (const tbl of ["reward_spin_entitlements", "loyalty_ledger", "loyalty_customers", "loyalty_programs", "api_keys"])
      await sql.query(`DELETE FROM ${tbl} WHERE tenant = $1`, [tenant]);
  });
  // Tạo key trực tiếp ở tầng repository (tạo qua API cần phiên PocketBase).
  const { createNeonRepository } = await import("../src/neonRepository.js");
  const { generateApiKey, sha256Hex } = await import("../src/auth.js");
  const repo = createNeonRepository(url);
  const key = generateApiKey();
  const record = await repo.createApiKey({ tenant, name: "POS 1", keyPrefix: key.slice(0, 10), keyHash: await sha256Hex(key) });
  assert.ok(key.startsWith("lsk_"));
  assert.equal((await sql.query("SELECT key_hash FROM api_keys WHERE id=$1", [record.id]))[0].key_hash.includes(key), false);

  assert.equal((await call("/api/v1/loyalty/program", { key: "lsk_sai" })).status, 401);
  assert.equal((await call("/api/v1/loyalty/program")).status, 401);
  assert.equal((await call("/api/v1/loyalty/program", { key })).status, 200);

  // Key không tự quản lý được key.
  assert.equal((await call("/api/v1/loyalty/api-keys", { key })).status, 403);

  assert.equal((await call("/api/v1/loyalty/program", { key, method: "PUT", body: { spend_per_point_minor: 10000 } })).status, 200);
  const sale = { idempotency_key: "pos:HD1", customer_ref: "0909", source_type: "pos", source_ref: "HD1", amount_minor: 250000 };
  const r1 = await call("/api/v1/loyalty/sales", { key, method: "POST", body: sale });
  assert.equal(r1.status, 201); assert.equal(Number((await r1.json()).entry.points_delta), 25);
  assert.equal((await call("/api/v1/loyalty/sales", { key, method: "POST", body: sale })).status, 200);
  assert.equal((await (await call("/api/v1/loyalty/account?customer_ref=0909", { key })).json()).balance, 25);

  await repo.revokeApiKey(tenant, record.id);
  assert.equal((await call("/api/v1/loyalty/program", { key })).status, 401);
});
