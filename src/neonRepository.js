import { neon } from "@neondatabase/serverless";
import { LoyaltyConflictError } from "./domain/loyalty/errors.js";
import { createGamesRepository } from "./gamesRepository.js";

// Cột được phép ghi cho từng bảng (id tự sinh). Giữ tên cột trùng với field PocketBase cũ
// để workflow/domain dùng lại nguyên vẹn.
const COLUMNS = {
  loyalty_programs: ["tenant", "version", "currency", "spend_per_point_minor", "points_per_step", "status"],
  loyalty_customers: ["tenant", "customer_ref", "name", "phone", "status", "metadata_json"],
  loyalty_ledger: ["tenant", "customer_id", "customer_ref", "transaction_type", "points_delta", "amount_minor", "currency",
    "source_type", "source_ref", "rule_version", "idempotency_key", "occurred_at", "reverses_entry_id", "metadata_json"],
  reward_campaigns: ["name", "description", "status", "starts_at", "ends_at", "spend_per_spin_minor", "max_spins_per_sale", "theme_json"],
  reward_campaign_prizes: ["campaign_id", "name", "prize_type", "weight", "max_wins", "sort_order", "status", "value_json"],
  reward_store_joins: ["tenant", "campaign_id", "status", "joined_at"],
  reward_spin_entitlements: ["tenant", "campaign_id", "customer_ref", "source_type", "source_ref", "status", "issued_at"],
  reward_spin_results: ["tenant", "campaign_id", "customer_ref", "entitlement_id", "prize_id", "prize_name", "prize_type",
    "prize_value_json", "prize_slot_key", "idempotency_key", "status", "game", "spun_at"],
  reward_claims: ["tenant", "campaign_id", "result_id", "customer_ref", "prize_id", "prize_name", "prize_type",
    "prize_value_json", "claim_note", "claimed_at"],
};
const NUMERIC_COLUMNS = ["points_delta", "amount_minor", "spend_per_point_minor", "spend_per_spin_minor", "weight", "target", "spend_per_ticket_minor", "ticket_count", "customer_count", "winner_count"];
const NULLABLE_DATES = new Set(["starts_at", "ends_at"]);
const SELECT = "*, created_at AS created";
const isUnique = (error) => error?.code === "23505";

export function createNeonRepository(databaseUrl) {
  const sql = neon(databaseUrl);
  // bigint/numeric được driver trả về dạng chuỗi; đổi sang number cho các cột số nguyên nghiệp vụ.
  const toNumber = (row) => {
    for (const key of NUMERIC_COLUMNS) if (typeof row[key] === "string") row[key] = Number(row[key]);
    return row;
  };
  const query = async (text, params = []) => (await sql.query(text, params)).map(toNumber);
  const one = async (text, params) => (await query(text, params))[0] || null;

  const clean = (column, value) => (value === "" && NULLABLE_DATES.has(column) ? null : value);

  async function insert(table, record) {
    const cols = COLUMNS[table].filter((c) => record[c] !== undefined);
    const values = cols.map((c) => clean(c, record[c]));
    const marks = ["$1", ...cols.map((_, i) => `$${i + 2}`)];
    return one(
      `INSERT INTO ${table} (id, ${cols.join(", ")}) VALUES (${marks.join(", ")}) RETURNING ${SELECT}`,
      [crypto.randomUUID(), ...values],
    );
  }
  async function update(table, id, patch) {
    const cols = COLUMNS[table].filter((c) => patch[c] !== undefined);
    if (!cols.length) return get(table, id);
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
    return one(`UPDATE ${table} SET ${sets} WHERE id = $1 RETURNING ${SELECT}`, [id, ...cols.map((c) => clean(c, patch[c]))]);
  }
  const get = (table, id) => one(`SELECT ${SELECT} FROM ${table} WHERE id = $1`, [id]);

  const repo = {
    // ---- API key (chỉ lưu hash)
    createApiKey: ({ tenant, name, keyPrefix, keyHash }) => one(
      `INSERT INTO api_keys (id, tenant, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant, name, key_prefix, created_at, last_used_at, revoked_at`,
      [crypto.randomUUID(), tenant, name, keyPrefix, keyHash]),
    findActiveApiKey: (keyHash) => one(
      "SELECT id, tenant FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL", [keyHash]),
    touchApiKey: (id) => query(
      "UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [id]),
    listApiKeys: (tenant) => query(
      `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_keys
       WHERE tenant = $1 AND revoked_at IS NULL ORDER BY created_at DESC`, [tenant]),
    revokeApiKey: (tenant, id) => one(
      "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant = $2 AND revoked_at IS NULL RETURNING id", [id, tenant]),

    // ---- Thống kê tổng quan & lượt quay còn lại
    async getStats(tenant) {
      const tz = "Asia/Ho_Chi_Minh";
      const [totals, spins, daily, recent, today] = await Promise.all([
        one(`SELECT (SELECT COUNT(*) FROM loyalty_customers WHERE tenant = $1) AS customers,
               COALESCE(SUM(points_delta) FILTER (WHERE points_delta > 0), 0) AS points_issued,
               COALESCE(-SUM(points_delta) FILTER (WHERE points_delta < 0), 0) AS points_redeemed,
               COALESCE(SUM(amount_minor) FILTER (WHERE transaction_type = 'earn' AND occurred_at >= now() - interval '30 days'), 0) AS sales_30d,
               COUNT(*) FILTER (WHERE transaction_type = 'earn' AND (occurred_at AT TIME ZONE '${tz}')::date = (now() AT TIME ZONE '${tz}')::date) AS receipts_today
             FROM loyalty_ledger WHERE tenant = $1`, [tenant]),
        one(`SELECT
               (SELECT COUNT(*) FROM reward_spin_entitlements e WHERE e.tenant = $1 AND e.status = 'available'
                  AND NOT EXISTS (SELECT 1 FROM reward_spin_results r WHERE r.entitlement_id = e.id)) AS spins_available,
               (SELECT COUNT(*) FROM reward_spin_results WHERE tenant = $1) AS spins_used,
               (SELECT COUNT(*) FROM reward_spin_results WHERE tenant = $1 AND status = 'won') AS prizes_pending`, [tenant]),
        query(`SELECT to_char((occurred_at AT TIME ZONE '${tz}')::date, 'YYYY-MM-DD') AS day,
                 COALESCE(SUM(amount_minor) FILTER (WHERE transaction_type = 'earn'), 0) AS amount,
                 COALESCE(SUM(points_delta) FILTER (WHERE points_delta > 0), 0) AS points,
                 COUNT(*) FILTER (WHERE transaction_type = 'earn') AS receipts
               FROM loyalty_ledger WHERE tenant = $1 AND occurred_at >= now() - interval '15 days'
               GROUP BY 1 ORDER BY 1`, [tenant]),
        query(`SELECT l.id, l.transaction_type, l.points_delta, l.amount_minor, l.source_ref, l.occurred_at, l.customer_ref, c.name
               FROM loyalty_ledger l JOIN loyalty_customers c ON c.id = l.customer_id
               WHERE l.tenant = $1 ORDER BY l.occurred_at DESC, l.created_at DESC LIMIT 8`, [tenant]),
        one(`SELECT to_char(now() AT TIME ZONE '${tz}', 'YYYY-MM-DD') AS today`),
      ]);
      const n = (row, keys) => Object.fromEntries(keys.map((k) => [k, Number(row[k])]));
      return {
        ...n(totals, ["customers", "points_issued", "points_redeemed", "sales_30d", "receipts_today"]),
        ...n(spins, ["spins_available", "spins_used", "prizes_pending"]),
        today: today.today,
        daily: daily.map((d) => ({ day: d.day, amount: Number(d.amount), points: Number(d.points), receipts: Number(d.receipts) })),
        recent,
      };
    },
    async countAvailableSpins(tenant, customerRef) {
      const rows = await query(
        `SELECT e.campaign_id, COUNT(*) AS n FROM reward_spin_entitlements e
         WHERE e.tenant = $1 AND e.customer_ref = $2 AND e.status = 'available'
           AND NOT EXISTS (SELECT 1 FROM reward_spin_results r WHERE r.entitlement_id = e.id)
         GROUP BY e.campaign_id`, [tenant, customerRef]);
      const campaigns = rows.map((r) => ({ campaign_id: r.campaign_id, available: Number(r.n) }));
      return { available: campaigns.reduce((sum, c) => sum + c.available, 0), campaigns };
    },

    // ---- Chương trình tích điểm
    getActiveProgram: (tenant) => one(
      `SELECT ${SELECT} FROM loyalty_programs WHERE tenant = $1 AND status = 'active' ORDER BY version DESC LIMIT 1`, [tenant]),
    async nextProgramVersion(tenant) {
      const row = await one("SELECT COALESCE(MAX(version), 0) AS v FROM loyalty_programs WHERE tenant = $1", [tenant]);
      return Number(row.v) + 1;
    },
    createProgram: (program) => insert("loyalty_programs", program),
    updateProgram: (id, patch) => update("loyalty_programs", id, patch),
    async archiveActivePrograms(tenant, exceptProgramId = null) {
      await query("UPDATE loyalty_programs SET status = 'archived' WHERE tenant = $1 AND status = 'active' AND id <> $2",
        [tenant, exceptProgramId || ""]);
    },

    // ---- Khách hàng
    findCustomerByRef: (tenant, ref) => one(
      `SELECT ${SELECT} FROM loyalty_customers WHERE tenant = $1 AND customer_ref = $2`, [tenant, ref]),
    async findOrCreateCustomer(tenant, customerRef, profile = {}) {
      const existing = await this.findCustomerByRef(tenant, customerRef);
      if (existing) return existing;
      try {
        return await insert("loyalty_customers", { tenant, customer_ref: customerRef, name: profile.name || "", phone: profile.phone || "", status: "active" });
      } catch (cause) {
        const winner = await this.findCustomerByRef(tenant, customerRef);
        if (winner) return winner;
        throw cause;
      }
    },

    // ---- Sổ cái
    findLedgerByIdempotencyKey: (tenant, key) => one(
      `SELECT ${SELECT} FROM loyalty_ledger WHERE tenant = $1 AND idempotency_key = $2`, [tenant, key]),
    findLedgerBySource: (tenant, type, ref) => one(
      `SELECT ${SELECT} FROM loyalty_ledger WHERE tenant = $1 AND source_type = $2 AND source_ref = $3`, [tenant, type, ref]),
    async appendLedger(entry) {
      const cols = COLUMNS.loyalty_ledger.filter((c) => entry[c] !== undefined);
      const params = cols.map((c) => entry[c]);
      const marks = cols.map((_, i) => `$${i + 2}`);
      const deltaIdx = cols.indexOf("points_delta") + 2;
      const tenantIdx = cols.indexOf("tenant") + 2;
      const customerIdx = cols.indexOf("customer_id") + 2;
      // Với giao dịch trừ điểm, kiểm tra số dư ngay trong câu INSERT để hai lần đổi
      // thưởng đồng thời không làm số dư âm.
      const row = await one(
        `INSERT INTO loyalty_ledger (id, ${cols.join(", ")})
         SELECT $1, ${marks.join(", ")}
         WHERE $${deltaIdx}::bigint >= 0 OR (
           SELECT COALESCE(SUM(points_delta), 0) FROM loyalty_ledger WHERE tenant = $${tenantIdx} AND customer_id = $${customerIdx}
         ) + $${deltaIdx}::bigint >= 0
         ON CONFLICT DO NOTHING
         RETURNING ${SELECT}`,
        [crypto.randomUUID(), ...params],
      );
      if (row) return { entry: row, replayed: false };
      const winner = await this.findLedgerByIdempotencyKey(entry.tenant, entry.idempotency_key);
      if (winner) return { entry: winner, replayed: true };
      if (await this.findLedgerBySource(entry.tenant, entry.source_type, entry.source_ref)) {
        throw new LoyaltyConflictError("This receipt/source was already used.");
      }
      throw new LoyaltyConflictError("Insufficient points.");
    },
    async listCustomerLedger(tenant, customerId, { page = 1, perPage = 100 } = {}) {
      const [items, count] = await Promise.all([
        query(`SELECT ${SELECT} FROM loyalty_ledger WHERE tenant = $1 AND customer_id = $2 ORDER BY created_at, id LIMIT $3 OFFSET $4`,
          [tenant, customerId, perPage, (page - 1) * perPage]),
        one("SELECT COUNT(*) AS n FROM loyalty_ledger WHERE tenant = $1 AND customer_id = $2", [tenant, customerId]),
      ]);
      const totalItems = Number(count.n);
      return { items, page, perPage, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / perPage)) };
    },
    listAllCustomerLedger: (tenant, customerId) => query(
      "SELECT points_delta FROM loyalty_ledger WHERE tenant = $1 AND customer_id = $2", [tenant, customerId]),

    // ---- Reward World: chương trình & giải thưởng (dùng chung mọi cửa hàng)
    listRewardCampaigns: () => query(`SELECT ${SELECT} FROM reward_campaigns WHERE status = 'active' ORDER BY starts_at NULLS FIRST`),
    listAllRewardCampaigns: () => query(`SELECT ${SELECT} FROM reward_campaigns ORDER BY created_at DESC`),
    createRewardCampaign: (record) => insert("reward_campaigns", record),
    updateRewardCampaign: (id, patch) => update("reward_campaigns", id, patch),
    getRewardCampaign: (id) => get("reward_campaigns", id),
    listCampaignPrizes: (campaignId) => query(
      `SELECT ${SELECT} FROM reward_campaign_prizes WHERE campaign_id = $1 AND status = 'active' ORDER BY sort_order, created_at`, [campaignId]),
    listAllCampaignPrizes: (campaignId) => query(
      `SELECT ${SELECT} FROM reward_campaign_prizes WHERE campaign_id = $1 ORDER BY sort_order, created_at`, [campaignId]),
    createCampaignPrize: (record) => insert("reward_campaign_prizes", record),
    getCampaignPrize: (id) => get("reward_campaign_prizes", id),
    updateCampaignPrize: (id, patch) => update("reward_campaign_prizes", id, patch),
    async listAvailableCampaignPrizes(campaignId) {
      const rows = await query(
        `SELECT p.*, p.created_at AS created, COUNT(r.id) AS wins
         FROM reward_campaign_prizes p LEFT JOIN reward_spin_results r ON r.prize_id = p.id
         WHERE p.campaign_id = $1 AND p.status = 'active'
         GROUP BY p.id ORDER BY p.sort_order, p.created_at`, [campaignId]);
      return rows
        .filter((p) => !Number(p.max_wins) || Number(p.wins) < Number(p.max_wins))
        .map((p) => ({ ...p, next_win_number: Number(p.wins) + 1 }));
    },

    // ---- Cửa hàng tham gia, lượt quay, kết quả
    listStoreCampaignJoins: (tenant) => query(
      `SELECT ${SELECT} FROM reward_store_joins WHERE tenant = $1 AND status = 'active'`, [tenant]),
    findStoreCampaignJoin: (tenant, campaignId) => one(
      `SELECT ${SELECT} FROM reward_store_joins WHERE tenant = $1 AND campaign_id = $2 AND status = 'active'`, [tenant, campaignId]),
    async joinRewardCampaign(tenant, campaignId, joinedAt) {
      const existing = await this.findStoreCampaignJoin(tenant, campaignId);
      if (existing) return { join: existing, replayed: true };
      try { return { join: await insert("reward_store_joins", { tenant, campaign_id: campaignId, status: "active", joined_at: joinedAt }), replayed: false }; }
      catch (cause) {
        const winner = await this.findStoreCampaignJoin(tenant, campaignId);
        if (winner) return { join: winner, replayed: true };
        throw cause;
      }
    },
    async issueRewardEntitlementsForSale({ tenant, customerRef, sourceRef, amountMinor, occurredAt }) {
      const issued = [];
      for (const join of await this.listStoreCampaignJoins(tenant)) {
        const campaign = await this.getRewardCampaign(join.campaign_id);
        if (!campaign || campaign.status !== "active") continue;
        const threshold = Math.max(1, Number(campaign.spend_per_spin_minor || 1));
        const count = Math.min(Math.floor(amountMinor / threshold), Math.max(1, Number(campaign.max_spins_per_sale || 1)));
        for (let ordinal = 1; ordinal <= count; ordinal += 1) {
          const row = await one(
            `INSERT INTO reward_spin_entitlements (id, tenant, campaign_id, customer_ref, source_type, source_ref, status, issued_at)
             VALUES ($1, $2, $3, $4, 'sale', $5, 'available', $6)
             ON CONFLICT (tenant, campaign_id, source_type, source_ref) DO UPDATE SET source_ref = EXCLUDED.source_ref
             RETURNING ${SELECT}`,
            [crypto.randomUUID(), tenant, campaign.id, customerRef, `${sourceRef}:${ordinal}`, occurredAt]);
          issued.push(row);
        }
      }
      return issued;
    },
    findSpinResultByIdempotency: (tenant, key) => one(
      `SELECT ${SELECT} FROM reward_spin_results WHERE tenant = $1 AND idempotency_key = $2`, [tenant, key]),
    findAvailableSpinEntitlement: (tenant, campaignId, customerRef) => one(
      `SELECT e.*, e.created_at AS created FROM reward_spin_entitlements e
       WHERE e.tenant = $1 AND e.campaign_id = $2 AND e.customer_ref = $3 AND e.status = 'available'
         AND NOT EXISTS (SELECT 1 FROM reward_spin_results r WHERE r.entitlement_id = e.id)
       ORDER BY e.created_at LIMIT 1`, [tenant, campaignId, customerRef]),
    async createSpinResult(record) {
      try { return { result: await insert("reward_spin_results", record), replayed: false }; }
      catch (cause) {
        if (!isUnique(cause)) throw cause;
        const replay = await this.findSpinResultByIdempotency(record.tenant, record.idempotency_key);
        if (replay) return { result: replay, replayed: true };
        const used = await one(`SELECT ${SELECT} FROM reward_spin_results WHERE entitlement_id = $1`, [record.entitlement_id]);
        if (used) return { result: used, replayed: true };
        throw new LoyaltyConflictError("Prize inventory changed during the spin. Please retry with the same request key.");
      }
    },
    getSpinResultForTenant: (tenant, id) => one(
      `SELECT ${SELECT} FROM reward_spin_results WHERE id = $1 AND tenant = $2`, [id, tenant]),
    findClaimByResult: (resultId) => one(`SELECT ${SELECT} FROM reward_claims WHERE result_id = $1`, [resultId]),
    async createRewardClaim(record) {
      try { return { claim: await insert("reward_claims", record), replayed: false }; }
      catch (cause) {
        const winner = await this.findClaimByResult(record.result_id);
        if (winner) return { claim: winner, replayed: true };
        throw cause;
      }
    },
    markSpinClaimed: (id) => query("UPDATE reward_spin_results SET status = 'claimed' WHERE id = $1", [id]),
    async listCustomerWins(tenant, customerRef) {
      return query(
        `SELECT r.*, r.created_at AS created, CASE WHEN c.id IS NULL THEN NULL ELSE to_jsonb(c) END AS claim
         FROM reward_spin_results r LEFT JOIN reward_claims c ON c.result_id = r.id
         WHERE r.tenant = $1 AND r.customer_ref = $2 AND r.status IN ('won', 'claimed')
         ORDER BY r.spun_at DESC LIMIT 100`, [tenant, customerRef]);
    },
  };
  Object.assign(repo, createGamesRepository({ query, one, repo }));
  return repo;
}
