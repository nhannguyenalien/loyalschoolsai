import { createNeonRepository } from "../../../src/neonRepository.js";
import { createLoyaltyApi } from "../../../src/api/loyalty.js";
import { createRewardWorldAdminApi } from "../../../src/api/rewardWorldAdmin.js";
import { authenticateTenant, HttpError, requireAdmin } from "../../../src/auth.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export async function onRequest({ request, env }) {
  try {
    if (!env.DATABASE_URL) throw new HttpError(500, "DATABASE_URL is not configured.");
    const repository = createNeonRepository(env.DATABASE_URL);
    const path = new URL(request.url).pathname;
    let response = null;
    if (path.startsWith("/api/v1/admin/")) {
      requireAdmin(request, env);
      response = await createRewardWorldAdminApi({ repository })(request, {});
    } else if (path.startsWith("/api/v1/loyalty")) {
      const { tenant } = await authenticateTenant(request, env);
      response = await createLoyaltyApi({ repository })(request, { tenant });
    }
    return response || json(404, { error: "Not found." });
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    console.error(error);
    return json(500, { error: "Internal server error." });
  }
}
