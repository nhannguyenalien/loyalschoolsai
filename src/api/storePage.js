import { HttpError } from "../auth.js";
import { PinError, resetCustomerPin } from "../pin.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const view = ({ slug, name, enabled, require_pin, created_at }) => ({ slug, name, enabled, require_pin, created_at }); // không lộ tenant (uid)
const SLUG = /^[a-z0-9][a-z0-9-]{2,29}$/;
const randomSlug = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

/** Chủ cửa hàng xem/sửa trang công khai của mình. Lần đầu tự tạo slug ngẫu nhiên. */
export function createStorePageApi({ repository }) {
  return async (request, { tenant, user }) => {
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    if (path === "/api/v1/loyalty/store-page/pin-reset" && request.method === "POST") {
      // Chủ cửa hàng đặt lại PIN của một khách (body: customer_ref, pin? — bỏ trống = xóa để khách tự tạo lại).
      const body = await request.json().catch(() => ({}));
      const ref = String(body.customer_ref || "").replace(/[\s.\-()]/g, "");
      if (!ref) throw new HttpError(400, "customer_ref is required.");
      if (!(await repository.findCustomerByRef(tenant, ref))) throw new HttpError(404, "Customer not found.");
      try { return json(200, await resetCustomerPin({ repository, tenant, ref, pin: body.pin })); }
      catch (error) { if (error instanceof PinError) throw new HttpError(400, error.message); throw error; }
    }
    if (path !== "/api/v1/loyalty/store-page") return null;
    if (request.method === "GET") {
      const page = (await repository.getStorePage(tenant))
        || await repository.ensureStorePage({ tenant, slug: randomSlug(), name: (user?.name || "").slice(0, 80) || "My store" });
      return json(200, { page: view(page) });
    }
    if (request.method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const patch = {};
      if (body.slug !== undefined) {
        patch.slug = String(body.slug).trim().toLowerCase();
        if (!SLUG.test(patch.slug)) throw new HttpError(400, "slug must be 3–30 characters: lowercase letters, numbers and hyphens.");
      }
      if (body.name !== undefined) {
        patch.name = String(body.name).trim();
        if (!patch.name || patch.name.length > 80) throw new HttpError(400, "name is required (max 80 characters).");
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
        patch.enabled = body.enabled;
      }
      if (body.require_pin !== undefined) {
        if (typeof body.require_pin !== "boolean") throw new HttpError(400, "require_pin must be true or false.");
        patch.require_pin = body.require_pin;
      }
      if (!(await repository.getStorePage(tenant))) throw new HttpError(404, "Open the page first (GET).");
      try {
        return json(200, { page: view(await repository.updateStorePage(tenant, patch)) });
      } catch (error) {
        if (error?.code === "23505") throw new HttpError(409, "This link is already taken. Please choose another one.");
        throw error;
      }
    }
    return null;
  };
}
