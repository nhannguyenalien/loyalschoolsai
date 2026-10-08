import { API_KEY_PREFIX, generateApiKey, HttpError, sha256Hex } from "../auth.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Quản lý API key của một tenant. Chỉ dùng được bằng phiên đăng nhập, không dùng bằng API key. */
export function createApiKeysApi({ repository }) {
  return async (request, { tenant, via }) => {
    if (via !== "session") throw new HttpError(403, "API keys can only be managed from a signed-in session.");
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    if (request.method === "GET" && path === "/api/v1/loyalty/api-keys") {
      return json(200, { keys: await repository.listApiKeys(tenant) });
    }
    if (request.method === "POST" && path === "/api/v1/loyalty/api-keys") {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "").trim();
      if (!name || name.length > 100) throw new HttpError(400, "name is required (max 100 characters).");
      const key = generateApiKey();
      const record = await repository.createApiKey({ tenant, name, keyPrefix: key.slice(0, API_KEY_PREFIX.length + 6), keyHash: await sha256Hex(key) });
      return json(201, { key, record }); // key chỉ trả về lần này
    }
    const match = path.match(/^\/api\/v1\/loyalty\/api-keys\/([^/]+)$/);
    if (request.method === "DELETE" && match) {
      const revoked = await repository.revokeApiKey(tenant, decodeURIComponent(match[1]));
      return revoked ? json(200, { revoked: true }) : json(404, { error: "API key was not found." });
    }
    return null;
  };
}
