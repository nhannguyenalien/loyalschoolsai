import { LoyaltyConflictError, LoyaltyNotFoundError, LoyaltyValidationError } from "../domain/loyalty/errors.js";
import { checkIn, getCheckinStatus, getGameSettings, saveGameSettings } from "../workflows/games/checkin.js";
import { claimMission, createMission, getMissionBoard, listMissionsAdmin, updateMission } from "../workflows/games/missions.js";
import { claimDrawWinner, createDraw, getDrawDetail, grantTickets, listDraws, runDraw, updateDraw } from "../workflows/games/draws.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
async function readJson(request) {
  try { return await request.json(); } catch { throw new LoyaltyValidationError("Request body must be valid JSON."); }
}
const decode = decodeURIComponent;

/** API game: điểm danh, chuỗi, nhiệm vụ ngày, quay số may mắn. Mọi thao tác theo tenant của người gọi. */
export function createGamesApi({ repository }) {
  return async function handleGames(request, { tenant }) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");
    const base = "/api/v1/loyalty/games";
    if (!path.startsWith(`${base}/`)) return null;
    const route = path.slice(base.length);
    const method = request.method;
    const customerRef = url.searchParams.get("customer_ref");
    try {
      if (route === "/settings") {
        if (method === "GET") return json(200, await getGameSettings({ repository, tenant }));
        if (method === "PUT") return json(200, await saveGameSettings({ repository, tenant, input: await readJson(request) }));
      }
      if (route === "/checkin") {
        if (method === "GET") return json(200, await getCheckinStatus({ repository, tenant, customerRef }));
        if (method === "POST") {
          const result = await checkIn({ repository, tenant, customerRef: (await readJson(request)).customer_ref });
          return json(result.replayed ? 200 : 201, result);
        }
      }
      if (route === "/missions") {
        if (method === "GET") return json(200, customerRef ? await getMissionBoard({ repository, tenant, customerRef }) : await listMissionsAdmin({ repository, tenant }));
        if (method === "POST") return json(201, await createMission({ repository, tenant, input: await readJson(request) }));
      }
      let m = route.match(/^\/missions\/([^/]+)$/);
      if (m && method === "PATCH") return json(200, await updateMission({ repository, tenant, missionId: decode(m[1]), input: await readJson(request) }));
      m = route.match(/^\/missions\/([^/]+)\/claim$/);
      if (m && method === "POST") {
        const result = await claimMission({ repository, tenant, missionId: decode(m[1]), customerRef: (await readJson(request)).customer_ref });
        return json(result.replayed ? 200 : 201, result);
      }
      if (route === "/draws") {
        if (method === "GET") return json(200, await listDraws({ repository, tenant }));
        if (method === "POST") return json(201, await createDraw({ repository, tenant, input: await readJson(request) }));
      }
      m = route.match(/^\/draws\/([^/]+)$/);
      if (m) {
        if (method === "GET") return json(200, await getDrawDetail({ repository, tenant, drawId: decode(m[1]), customerRef }));
        if (method === "PATCH") return json(200, await updateDraw({ repository, tenant, drawId: decode(m[1]), input: await readJson(request) }));
      }
      m = route.match(/^\/draws\/([^/]+)\/tickets$/);
      if (m && method === "POST") return json(201, await grantTickets({ repository, tenant, drawId: decode(m[1]), input: await readJson(request) }));
      m = route.match(/^\/draws\/([^/]+)\/draw$/);
      if (m && method === "POST") return json(201, await runDraw({ repository, tenant, drawId: decode(m[1]) }));
      m = route.match(/^\/draws\/([^/]+)\/winners\/([^/]+)\/claim$/);
      if (m && method === "POST") return json(200, await claimDrawWinner({ repository, tenant, drawId: decode(m[1]), winnerId: decode(m[2]) }));
      return null;
    } catch (error) {
      if (error instanceof LoyaltyValidationError) return json(400, { error: error.message });
      if (error instanceof LoyaltyNotFoundError) return json(404, { error: error.message });
      if (error instanceof LoyaltyConflictError) return json(409, { error: error.message });
      throw error;
    }
  };
}
