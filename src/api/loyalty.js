import { configureLoyaltyProgram } from "../workflows/loyalty/configureProgram.js";
import { recordLoyaltySale } from "../workflows/loyalty/recordSale.js";
import { recordLoyaltyEvent } from "../workflows/loyalty/recordEvent.js";
import { getLoyaltyAccount } from "../workflows/loyalty/getAccount.js";
import { redeemLoyaltyPoints } from "../workflows/loyalty/redeemPoints.js";
import { requireNonEmpty } from "../domain/loyalty/points.js";
import { LoyaltyConflictError, LoyaltyNotFoundError, LoyaltyValidationError } from "../domain/loyalty/errors.js";
import { createNotifier } from "../webhookNotifier.js";
import { claimReward, joinRewardCampaign, listCustomerRewards, listRewardWorld, spinRewardWorld } from "../workflows/loyalty/rewardWorld.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...JSON_HEADERS } });

async function readJson(request) {
  try { return await request.json(); }
  catch { throw new LoyaltyValidationError("Request body must be valid JSON."); }
}

function positivePage(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value || fallback);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

const earnedEvents = (customerRef, result) => [
  ["points.earned", { customer_ref: customerRef, points: Number(result.entry.points_delta), amount_minor: Number(result.entry.amount_minor), source_ref: result.entry.source_ref }],
  ...(result.entitlements?.length ? [["spin.issued", { customer_ref: customerRef, spins: result.entitlements.length, source_ref: result.entry.source_ref }]] : []),
];
const eventEvents = (r) => {
  if (r.type === "purchase") return earnedEvents(r.customer_ref, r.detail);
  if (r.type === "redeem") return [["points.redeemed", { customer_ref: r.customer_ref, points: Math.abs(r.points_delta), balance: r.balance }]];
  return [["checkin.completed", { customer_ref: r.customer_ref, points: r.points_delta, streak: r.detail.streak, milestone: r.detail.milestone, balance: r.balance }]];
};

export function createLoyaltyApi({ repository, fulfillmentService }) {
  if (!repository) throw new Error("Loyalty API requires a repository.");
  return async function handleLoyalty(request, context) {
    const tenant = context?.tenant;
    const responseHeaders = context?.responseHeaders;
    const notify = createNotifier({ repository, tenant, waitUntil: context?.waitUntil });
    if (!tenant) return json(401, { error: "Authentication is required." }, responseHeaders);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");
    try {
      if (request.method === "GET" && path === "/api/v1/loyalty/program") {
        return json(200, { program: await repository.getActiveProgram(tenant) }, responseHeaders);
      }
      if (request.method === "PUT" && path === "/api/v1/loyalty/program") {
        return json(200, await configureLoyaltyProgram({ repository, tenant, input: await readJson(request) }), responseHeaders);
      }
      if (request.method === "POST" && path === "/api/v1/loyalty/sales") {
        const input = await readJson(request);
        const result = await recordLoyaltySale({ repository, tenant, input });
        if (!result.replayed) await notify(earnedEvents(input.customer_ref, result));
        return json(result.replayed ? 200 : 201, result, responseHeaders);
      }
      if (request.method === "POST" && path === "/api/v1/loyalty/events") {
        const result = await recordLoyaltyEvent({ repository, tenant, input: await readJson(request), idempotencyKey: request.headers.get("idempotency-key") });
        if (!result.replayed) await notify(eventEvents(result));
        return json(result.replayed ? 200 : 201, result, responseHeaders);
      }
      if (request.method === "POST" && path === "/api/v1/loyalty/redemptions") {
        const result = await redeemLoyaltyPoints({ repository, tenant, input: await readJson(request) });
        if (!result.replayed) await notify([["points.redeemed", { customer_ref: result.entry.customer_ref, points: Math.abs(Number(result.entry.points_delta)), balance: result.balance, source_ref: result.entry.source_ref }]]);
        return json(result.replayed ? 200 : 201, result, responseHeaders);
      }
      if (request.method === "GET" && path === "/api/v1/loyalty/account") {
        const result = await getLoyaltyAccount({
          repository, tenant, customerRef: url.searchParams.get("customer_ref"),
          page: positivePage(url.searchParams.get("page"), 1),
          perPage: positivePage(url.searchParams.get("per_page"), 100, 500),
        });
        return json(200, result, responseHeaders);
      }
      if (request.method === "GET" && path === "/api/v1/loyalty/stats") {
        return json(200, await repository.getStats(tenant), responseHeaders);
      }
      if (request.method === "GET" && path === "/api/v1/loyalty/reward-world/entitlements") {
        const customerRef = requireNonEmpty(url.searchParams.get("customer_ref"), "customer_ref", 200);
        return json(200, await repository.countAvailableSpins(tenant, customerRef), responseHeaders);
      }
      if (request.method === "GET" && path === "/api/v1/loyalty/reward-world/campaigns") {
        return json(200, await listRewardWorld({ repository, tenant }), responseHeaders);
      }
      const joinMatch = path.match(/^\/api\/v1\/loyalty\/reward-world\/campaigns\/([^/]+)\/join$/);
      if (request.method === "POST" && joinMatch) {
        return json(200, await joinRewardCampaign({ repository, tenant, campaignId: decodeURIComponent(joinMatch[1]) }), responseHeaders);
      }
      if (request.method === "POST" && path === "/api/v1/loyalty/reward-world/spins") {
        const result = await spinRewardWorld({ repository, tenant, input: await readJson(request) });
        if (!result.replayed && result.result) await notify([["reward.won", { customer_ref: result.result.customer_ref, prize: { id: result.result.prize_id, name: result.result.prize_name, type: result.result.prize_type }, result_id: result.result.id }]]);
        return json(result.replayed ? 200 : 201, result, responseHeaders);
      }
      if (request.method === "GET" && path === "/api/v1/loyalty/reward-world/rewards") {
        return json(200, await listCustomerRewards({ repository, tenant, customerRef: url.searchParams.get("customer_ref") }), responseHeaders);
      }
      const claimMatch = path.match(/^\/api\/v1\/loyalty\/reward-world\/results\/([^/]+)\/claim$/);
      if (request.method === "POST" && claimMatch) {
        const result = await claimReward({ repository, tenant, resultId: decodeURIComponent(claimMatch[1]), input: await readJson(request), fulfillmentService });
        return json(result.replayed ? 200 : 201, result, responseHeaders);
      }
      return null;
    } catch (error) {
      if (error instanceof LoyaltyValidationError) return json(400, { error: error.message }, responseHeaders);
      if (error instanceof LoyaltyNotFoundError) return json(404, { error: error.message }, responseHeaders);
      if (error instanceof LoyaltyConflictError) return json(409, { error: error.message }, responseHeaders);
      throw error;
    }
  };
}
