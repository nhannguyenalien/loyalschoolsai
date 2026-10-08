import { createRemoteJWKSet, jwtVerify } from "jose";

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const API_KEY_PREFIX = "lsk_";

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${API_KEY_PREFIX}${body}`;
}

// POS/hệ thống ngoài: `Authorization: Bearer lsk_...`. Trả về null nếu không phải API key.
export async function authenticateApiKey(request, repository) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith(API_KEY_PREFIX)) return null;
  const row = await repository.findActiveApiKey(await sha256Hex(token));
  if (!row) throw new HttpError(401, "API key is invalid or revoked.");
  repository.touchApiKey(row.id).catch(() => {});
  return { tenant: row.tenant, via: "api_key" };
}

const FIREBASE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));

/**
 * Xác thực Firebase ID token (RS256) và trả về cửa hàng của người dùng.
 * Mỗi tài khoản Firebase là một cửa hàng: tenant = uid.
 */
export async function authenticateTenant(request, env, { jwks = FIREBASE_JWKS } = {}) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Authentication is required.");
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new HttpError(500, "FIREBASE_PROJECT_ID is not configured.");
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer: `https://securetoken.google.com/${projectId}`, audience: projectId, algorithms: ["RS256"] }));
  } catch {
    throw new HttpError(401, "Session is invalid or expired.");
  }
  if (!payload.sub) throw new HttpError(401, "Session is invalid or expired.");
  return { tenant: payload.sub, user: { uid: payload.sub, email: payload.email || "", name: payload.name || "" }, via: "session" };
}

export function requireAdmin(request, env) {
  const given = request.headers.get("x-admin-secret") || "";
  const secret = env.ADMIN_SECRET || "";
  let diff = given.length ^ secret.length;
  for (let i = 0; i < Math.max(given.length, secret.length); i += 1) diff |= (given.charCodeAt(i) || 0) ^ (secret.charCodeAt(i) || 0);
  if (!secret || diff !== 0) throw new HttpError(401, "Admin secret is invalid.");
}
