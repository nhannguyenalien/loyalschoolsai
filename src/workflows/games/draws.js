import { pickDrawWinners, validateDraw } from "../../domain/games.js";
import { LoyaltyConflictError, LoyaltyNotFoundError, LoyaltyValidationError } from "../../domain/loyalty/errors.js";
import { requireNonEmpty } from "../../domain/loyalty/points.js";

export const listDraws = async ({ repository, tenant }) => ({ draws: await repository.listDraws(tenant) });
export const createDraw = async ({ repository, tenant, input }) => repository.createDraw(tenant, validateDraw(input));

export async function updateDraw({ repository, tenant, drawId, input }) {
  const current = await repository.getDraw(tenant, drawId);
  if (!current) throw new LoyaltyNotFoundError("Draw was not found.");
  if (current.status === "drawn") throw new LoyaltyConflictError("This draw has already been drawn and can no longer be edited.");
  const patch = validateDraw(input, { partial: true });
  const starts = patch.starts_at !== undefined ? patch.starts_at : current.starts_at;
  const ends = patch.ends_at !== undefined ? patch.ends_at : current.ends_at;
  if (starts && ends && new Date(ends) <= new Date(starts)) throw new LoyaltyValidationError("ends_at must be after starts_at.");
  const updated = await repository.updateDraw(tenant, drawId, patch);
  if (!updated) throw new LoyaltyConflictError("This draw has already been drawn and can no longer be edited.");
  return updated;
}

export async function getDrawDetail({ repository, tenant, drawId, customerRef }) {
  const draw = await repository.getDraw(tenant, drawId);
  if (!draw) throw new LoyaltyNotFoundError("Draw was not found.");
  const winners = await repository.listWinners(tenant, drawId);
  const tickets = customerRef ? await repository.listCustomerTickets(tenant, drawId, customerRef) : undefined;
  return { draw, winners, ...(tickets ? { tickets } : {}) };
}

/** Cấp vé thủ công cho khách (tối đa 50 vé / lần). `idempotency_key` giúp gọi lại không phát thêm vé. */
export async function grantTickets({ repository, tenant, drawId, input }) {
  const draw = await repository.getDraw(tenant, drawId);
  if (!draw) throw new LoyaltyNotFoundError("Draw was not found.");
  if (!["draft", "open"].includes(draw.status)) throw new LoyaltyConflictError("Tickets can only be issued while the draw is draft or open.");
  const customerRef = requireNonEmpty(input.customer_ref, "customer_ref", 200);
  const count = Number(input.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new LoyaltyValidationError("count must be an integer between 1 and 50.");
  const sourceRef = input.idempotency_key ? requireNonEmpty(input.idempotency_key, "idempotency_key", 200) : `manual:${crypto.randomUUID()}`;
  const tickets = await repository.issueTickets({ tenant, drawId, customerRef, sourceType: "manual", sourceRef, count });
  return { tickets };
}

/** Rút thăm: chọn ngẫu nhiên (CSPRNG) người thắng từ các vé và chốt kỳ trong một thao tác nguyên tử. */
export async function runDraw({ repository, tenant, drawId }) {
  const draw = await repository.getDraw(tenant, drawId);
  if (!draw) throw new LoyaltyNotFoundError("Draw was not found.");
  if (draw.status === "drawn") throw new LoyaltyConflictError("This draw has already been drawn.");
  if (draw.status === "draft") throw new LoyaltyConflictError("Open the draw before drawing.");
  const tickets = await repository.listAllTickets(tenant, drawId);
  if (!tickets.length) throw new LoyaltyConflictError("There are no tickets in this draw.");
  const winners = pickDrawWinners(tickets, draw.prizes, { onePerCustomer: draw.one_prize_per_customer });
  const saved = await repository.commitDraw(tenant, drawId, winners);
  if (!saved.length) throw new LoyaltyConflictError("This draw has already been drawn.");
  return { draw_id: drawId, tickets: tickets.length, winners: saved.sort((a, b) => a.prize_index - b.prize_index || a.ticket_no - b.ticket_no) };
}

export async function claimDrawWinner({ repository, tenant, drawId, winnerId }) {
  const winner = await repository.claimWinner(tenant, drawId, winnerId);
  if (!winner) throw new LoyaltyNotFoundError("Winner was not found.");
  return { winner };
}
