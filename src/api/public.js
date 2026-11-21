import { LoyaltyConflictError, LoyaltyNotFoundError, LoyaltyValidationError } from "../domain/loyalty/errors.js";
import { createNotifier } from "../webhookNotifier.js";
import { checkIn, getCheckinStatus } from "../workflows/games/checkin.js";
import { claimMission, getMissionBoard } from "../workflows/games/missions.js";
import { changePin, createInitialPin, PinError, validatePin, verifyCustomerPin } from "../pin.js";
import { listRewardWorld, spinRewardWorld } from "../workflows/loyalty/rewardWorld.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// Khách tự nhập số: bỏ dấu phân cách, giữ chữ số và dấu + đầu.
function normalizePhone(raw) {
  const phone = String(raw || "").replace(/[\s.\-()]/g, "");
  if (!/^\+?\d{6,15}$/.test(phone)) throw new LoyaltyValidationError("Số điện thoại không hợp lệ.");
  return phone;
}
const maskName = (name) => (String(name || "").trim().split(/\s+/).pop() || "Quý khách");

/**
 * API công khai cho trang khách (không đăng nhập), định danh cửa hàng bằng slug.
 * Giới hạn có chủ đích: khách phải ĐÃ có hồ sơ (do mua hàng tạo), không tạo khách mới, không lộ lịch sử giao dịch,
 * chỉ lộ tên gọi (không họ) + số dư.
 */
export function createPublicApi({ repository }) {
  return async (request, { waitUntil } = {}) => {
    const url = new URL(request.url);
    const m = url.pathname.replace(/\/$/, "").match(/^\/api\/v1\/public\/([a-z0-9-]{3,30})((?:\/[a-z0-9-]+)*)$/);
    if (!m) return null;
    const page = await repository.getEnabledStorePageBySlug(m[1]);
    if (!page) return json(404, { error: "Không tìm thấy cửa hàng." });
    const tenant = page.tenant, route = m[2], method = request.method;
    const notify = createNotifier({ repository, tenant, waitUntil });
    const body = async () => request.json().catch(() => { throw new LoyaltyValidationError("Request body must be valid JSON."); });
    const customerOf = async (phone) => {
      const customer = await repository.findCustomerByRef(tenant, phone);
      if (!customer || customer.status !== "active") throw new LoyaltyNotFoundError("Chưa tìm thấy số này. Hãy mua hàng lần đầu để nhận điểm nhé!");
      return customer;
    };
    // Chứng thực khách: phải có hồ sơ; nếu cửa hàng bật PIN thì phải nhập đúng PIN.
    const authed = async (input) => {
      const phone = normalizePhone(input?.phone);
      const customer = await customerOf(phone);
      if (page.require_pin) await verifyCustomerPin({ repository, tenant, ref: phone, pin: input?.pin });
      return { phone, customer };
    };
    try {
      if (method === "GET" && route === "") {
        const [program, settings, world] = await Promise.all([repository.getActiveProgram(tenant), repository.getGameSettings(tenant), listRewardWorld({ repository, tenant })]);
        return json(200, {
          store: { name: page.name }, pin_required: Boolean(page.require_pin),
          program: program ? { spend_per_point_minor: Number(program.spend_per_point_minor), points_per_step: Number(program.points_per_step), currency: program.currency } : null,
          checkin_points: settings.checkin_points, milestones: settings.streak_milestones,
          campaigns: world.campaigns.filter((c) => c.joined).map((c) => ({
            id: c.id, name: c.name, description: c.description,
            prizes: c.prizes.map((p) => ({ id: p.id, name: p.name, prize_type: p.prize_type })),
          })),
        });
      }
      if (method === "POST" && route === "/me") { // POST để số điện thoại không nằm trên URL/log
        const { phone, customer } = await authed(await body());
        const [balance, spins, checkin, day, week] = await Promise.all([
          repository.getBalance(tenant, phone), repository.countAvailableSpins(tenant, phone), getCheckinStatus({ repository, tenant, customerRef: phone }),
          getMissionBoard({ repository, tenant, customerRef: phone, period: "day" }), getMissionBoard({ repository, tenant, customerRef: phone, period: "week" }),
        ]);
        const slim = (mission) => ({ id: mission.id, name: mission.name, description: mission.description, kind: mission.kind, target: Number(mission.target), current: mission.current, completed: mission.completed, claimed: mission.claimed, reward_type: mission.reward_type, reward_points: mission.reward_points, reward_label: mission.reward_label });
        return json(200, {
          customer: { name: maskName(customer.name) }, balance, spins: spins.campaigns,
          checkin: { checked_in_today: checkin.checked_in_today, streak: checkin.streak, next_milestone: checkin.next_milestone },
          missions: day.missions.map(slim), challenges: week.missions.map(slim),
        });
      }
      if (method === "POST" && route === "/pin") { // tạo PIN lần đầu, hoặc đổi PIN (phải có PIN hiện tại)
        if (!page.require_pin) throw new LoyaltyConflictError("Cửa hàng này không dùng PIN.");
        const input = await body(), phone = normalizePhone(input.phone);
        await customerOf(phone);
        validatePin(input.new_pin, "new_pin");
        if (await repository.getCustomerPin(tenant, phone)) { await verifyCustomerPin({ repository, tenant, ref: phone, pin: input.pin }); await changePin({ repository, tenant, ref: phone, newPin: input.new_pin }); }
        else await createInitialPin({ repository, tenant, ref: phone, pin: input.new_pin });
        return json(200, { ok: true });
      }
      if (method === "POST" && route === "/checkin") {
        const { phone } = await authed(await body());
        const r = await checkIn({ repository, tenant, customerRef: phone });
        if (!r.replayed) await notify([["checkin.completed", { customer_ref: phone, points: r.points, streak: r.streak, milestone: r.milestone, balance: r.balance }]]);
        return json(r.replayed ? 200 : 201, { replayed: r.replayed, points: r.points, streak: r.streak, milestone: r.milestone, balance: r.balance });
      }
      const claim = route.match(/^\/missions\/([^/]+)\/claim$/);
      if (method === "POST" && claim) {
        const { phone } = await authed(await body());
        const r = await claimMission({ repository, tenant, missionId: decodeURIComponent(claim[1]), customerRef: phone });
        return json(r.replayed ? 200 : 201, { replayed: r.replayed, reward: r.reward, balance: r.balance });
      }
      if (method === "POST" && route === "/spin") {
        const input = await body();
        const { phone } = await authed(input);
        const requestId = String(input.request_id || "");
        if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new LoyaltyValidationError("request_id không hợp lệ.");
        const r = await spinRewardWorld({ repository, tenant, input: { campaign_id: input.campaign_id, customer_ref: phone, idempotency_key: `public:${requestId}`, game: "wheel" } });
        if (!r.replayed) await notify([["reward.won", { customer_ref: phone, prize: { id: r.result.prize_id, name: r.result.prize_name, type: r.result.prize_type }, result_id: r.result.id }]]);
        const left = await repository.countAvailableSpins(tenant, phone);
        return json(r.replayed ? 200 : 201, { replayed: r.replayed, prize: { id: r.result.prize_id, name: r.result.prize_name, prize_type: r.result.prize_type }, spins_left: left.campaigns });
      }
      return null;
    } catch (error) {
      if (error instanceof PinError) return json(error.status, { error: error.message, code: error.code, ...error.extra });
      if (error instanceof LoyaltyValidationError) return json(400, { error: error.message });
      if (error instanceof LoyaltyNotFoundError) return json(404, { error: error.message });
      if (error instanceof LoyaltyConflictError) return json(409, { error: error.message });
      throw error;
    }
  };
}
