import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { authenticateTenant, HttpError } from "../src/auth.js";

const env = { FIREBASE_PROJECT_ID: "demo" };
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", kid: "k1" }] });
const sign = (claims = {}, { iss = "https://securetoken.google.com/demo", aud = "demo", exp = "1h", key = privateKey } = {}) =>
  new SignJWT({ email: "a@b.com", ...claims }).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject("uid-123").setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key);
const req = (token) => new Request("http://t/x", { headers: token ? { authorization: `Bearer ${token}` } : {} });
const status = (promise) => promise.then(() => 200, (e) => (e instanceof HttpError ? e.status : 500));

test("Firebase ID token: hợp lệ → tenant = uid", async () => {
  const auth = await authenticateTenant(req(await sign()), env, { jwks });
  assert.equal(auth.tenant, "uid-123"); assert.equal(auth.user.email, "a@b.com"); assert.equal(auth.via, "session");
});

test("Firebase ID token: từ chối token sai", async () => {
  assert.equal(await status(authenticateTenant(req(), env, { jwks })), 401);
  assert.equal(await status(authenticateTenant(req("rac.roi.rac"), env, { jwks })), 401);
  assert.equal(await status(authenticateTenant(req(await sign({}, { aud: "other" })), env, { jwks })), 401);
  assert.equal(await status(authenticateTenant(req(await sign({}, { iss: "https://securetoken.google.com/other" })), env, { jwks })), 401);
  assert.equal(await status(authenticateTenant(req(await sign({}, { exp: "-1h" })), env, { jwks })), 401);
  const other = (await generateKeyPair("RS256")).privateKey; // ký bằng khoá lạ
  assert.equal(await status(authenticateTenant(req(await sign({}, { key: other })), env, { jwks })), 401);
  assert.equal(await status(authenticateTenant(req(await sign()), {}, { jwks })), 500);
});
