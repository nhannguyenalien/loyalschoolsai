import { HttpError } from "../auth.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const view = ({ slug, name, enabled, created_at }) => ({ slug, name, enabled, created_at }); // không lộ tenant (uid)
const SLUG = /^[a-z0-9][a-z0-9-]{2,29}$/;
const randomSlug = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");

/** Chủ cửa hàng xem/sửa trang công khai của mình. Lần đầu tự tạo slug ngẫu nhiên. */
export function createStorePageApi({ repository }) {
  return async (request, { tenant, user }) => {
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    if (path !== "/api/v1/loyalty/store-page") return null;
    if (request.method === "GET") {
      const page = (await repository.getStorePage(tenant))
        || await repository.ensureStorePage({ tenant, slug: randomSlug(), name: (user?.name || "").slice(0, 80) || "Cửa hàng của tôi" });
      return json(200, { page: view(page) });
    }
    if (request.method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const patch = {};
      if (body.slug !== undefined) {
        patch.slug = String(body.slug).trim().toLowerCase();
        if (!SLUG.test(patch.slug)) throw new HttpError(400, "slug gồm 3–30 ký tự: chữ thường, số, dấu gạch ngang.");
      }
      if (body.name !== undefined) {
        patch.name = String(body.name).trim();
        if (!patch.name || patch.name.length > 80) throw new HttpError(400, "name là bắt buộc (tối đa 80 ký tự).");
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled phải là true hoặc false.");
        patch.enabled = body.enabled;
      }
      if (!(await repository.getStorePage(tenant))) throw new HttpError(404, "Hãy mở trang trước (GET).");
      try {
        return json(200, { page: view(await repository.updateStorePage(tenant, patch)) });
      } catch (error) {
        if (error?.code === "23505") throw new HttpError(409, "Đường dẫn này đã có người dùng, hãy chọn tên khác.");
        throw error;
      }
    }
    return null;
  };
}
