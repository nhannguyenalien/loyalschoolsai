import { API_KEY_PREFIX, generateApiKey, HttpError, sha256Hex } from "../auth.js";
import { configureLoyaltyProgram } from "../workflows/loyalty/configureProgram.js";

/**
 * Kết nối một nút (kiểu OAuth authorization code + PKCE):
 *   1. Đối tác chuyển chủ cửa hàng tới /connect?redirect_uri&state&code_challenge&store
 *   2. Chủ cửa hàng đăng nhập, bấm "Cho phép" → POST /loyalty/connect/authorize → quay về redirect_uri kèm code
 *   3. Máy chủ đối tác POST /connect/token {code, code_verifier, redirect_uri} → nhận API key (không đi qua trình duyệt)
 * Chỉ chấp nhận redirect_uri thuộc danh sách origin cho phép (CONNECT_ALLOWED_ORIGINS) và đúng đường dẫn callback.
 */
// Các tên miền của POS (dự án Pages pos-app và bản thử allpos).
const DEFAULT_ORIGINS = "https://pos.schoolsai.work,https://pos.phanmemvangta.com,https://pos-app-bq8.pages.dev,https://allpos.pages.dev";
const CALLBACK_PATH = "/api/loyalty/callback";
const CODE_TTL_MS = 5 * 60 * 1000;
const PARTNER_CURRENCY = "VND"; // POS ghi tiền bằng VND

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const pkceChallenge = async (verifier) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

export function checkRedirectUri(value, env) {
  const allowed = String(env?.CONNECT_ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
  let url;
  try { url = new URL(String(value || "")); } catch { throw new HttpError(400, "redirect_uri is invalid."); }
  if (!allowed.includes(url.origin) || url.pathname !== CALLBACK_PATH || url.search || url.hash || url.username || url.password) {
    throw new HttpError(400, "This app is not allowed to connect.");
  }
  return url;
}

export function createConnectApi({ repository, env }) {
  return async (request, auth) => {
    const url = new URL(request.url), path = url.pathname.replace(/\/$/, ""), method = request.method;
    const body = async () => request.json().catch(() => ({}));

    // Đối tác đổi code lấy key (không cần đăng nhập; code + code_verifier chính là bằng chứng).
    if (method === "POST" && path === "/api/v1/connect/token") {
      const input = await body();
      const code = String(input.code || ""), verifier = String(input.code_verifier || "");
      if (!code || verifier.length < 43) throw new HttpError(400, "code and code_verifier are required.");
      const grant = await repository.consumeConnectCode(await sha256Hex(code));
      if (!grant || grant.redirect_uri !== input.redirect_uri || grant.code_challenge !== await pkceChallenge(verifier)) {
        throw new HttpError(400, "This connection code is invalid or expired.");
      }
      const tenant = grant.tenant;
      let program = await repository.getActiveProgram(tenant);
      if (program && program.currency !== PARTNER_CURRENCY) throw new HttpError(409, `The points rule must use ${PARTNER_CURRENCY} to connect this app.`);
      if (!program) program = await configureLoyaltyProgram({ repository, tenant, input: { currency: PARTNER_CURRENCY, spend_per_point_minor: 10000, points_per_step: 1 } });
      const storeName = grant.store_name || "My store";
      const slug = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
      const page = (await repository.getStorePage(tenant)) || await repository.ensureStorePage({ tenant, slug, name: storeName.slice(0, 80) });
      // Nối lại cùng một cửa hàng đối tác thì thay key cũ của đúng cửa hàng đó.
      const name = `SchoolsAI POS · ${storeName}`.slice(0, 100);
      await repository.revokeApiKeysByName(tenant, name);
      const key = generateApiKey();
      await repository.createApiKey({ tenant, name, keyPrefix: key.slice(0, API_KEY_PREFIX.length + 6), keyHash: await sha256Hex(key) });
      return json(200, {
        api_key: key, currency: program.currency,
        program: { spend_per_point_minor: Number(program.spend_per_point_minor), points_per_step: Number(program.points_per_step) },
        store: { name: page.name, public_url: `${url.origin}/c?s=${page.slug}` },
      });
    }

    // Đối tác ngắt kết nối: key tự thu hồi chính nó.
    if (method === "DELETE" && path === "/api/v1/loyalty/connect") {
      if (auth?.via !== "api_key") throw new HttpError(403, "Use the connected app's API key to disconnect.");
      await repository.revokeApiKey(auth.tenant, auth.keyId);
      return json(200, { disconnected: true });
    }

    if (auth?.via !== "session") throw new HttpError(403, "Sign in to approve a connection.");
    if (method === "GET" && path === "/api/v1/loyalty/connect/info") {
      const redirect = checkRedirectUri(url.searchParams.get("redirect_uri"), env);
      const program = await repository.getActiveProgram(auth.tenant);
      return json(200, { host: redirect.host, currency: program?.currency || null, required_currency: PARTNER_CURRENCY });
    }
    if (method === "POST" && path === "/api/v1/loyalty/connect/authorize") {
      const input = await body();
      const redirect = checkRedirectUri(input.redirect_uri, env);
      const state = String(input.state || ""), challenge = String(input.code_challenge || "");
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new HttpError(400, "state or code_challenge is invalid.");
      const program = await repository.getActiveProgram(auth.tenant);
      if (program && program.currency !== PARTNER_CURRENCY) throw new HttpError(409, `The points rule must use ${PARTNER_CURRENCY} to connect this app.`);
      const code = base64url(crypto.getRandomValues(new Uint8Array(32)));
      await repository.createConnectCode({
        codeHash: await sha256Hex(code), tenant: auth.tenant, redirectUri: String(input.redirect_uri), challenge,
        storeName: String(input.store || "").trim().slice(0, 80), expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      });
      redirect.searchParams.set("code", code); redirect.searchParams.set("state", state);
      return json(200, { redirect_to: redirect.toString() });
    }
    return null;
  };
}
