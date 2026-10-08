import { DEFAULT_GAME_SETTINGS } from "./domain/games.js";
import { LoyaltyConflictError } from "./domain/loyalty/errors.js";

const TZ = "Asia/Ho_Chi_Minh";
const CHECKIN_COLS = "id, tenant, customer_ref, to_char(day, 'YYYY-MM-DD') AS day, points, streak, created_at";
const DRAW_COLS = "id, tenant, name, description, status, starts_at, ends_at, spend_per_ticket_minor, max_tickets_per_sale, prizes, one_prize_per_customer, drawn_at, created_at";
const isUnique = (error) => error?.code === "23505";

/** Truy cập dữ liệu của các game. `repo` là repository loyalty chính (dùng để ghi sổ điểm). */
export function createGamesRepository({ query, one, repo }) {
  const newId = () => crypto.randomUUID();

  function buildUpdate(table, id, tenant, patch, allowed) {
    const cols = allowed.filter((c) => patch[c] !== undefined);
    if (!cols.length) return null;
    const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(", ");
    return [`UPDATE ${table} SET ${sets} WHERE id = $1 AND tenant = $2 RETURNING *`, [id, tenant, ...cols.map((c) => (c === "prizes" ? JSON.stringify(patch[c]) : patch[c]))]];
  }

  return {
    // ---------- Cấu hình
    async getGameSettings(tenant) {
      const row = await one("SELECT checkin_points, streak_milestones FROM game_settings WHERE tenant = $1", [tenant]);
      return row ? { checkin_points: row.checkin_points, streak_milestones: row.streak_milestones } : DEFAULT_GAME_SETTINGS;
    },
    async saveGameSettings(tenant, settings) {
      const row = await one(
        `INSERT INTO game_settings (tenant, checkin_points, streak_milestones) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (tenant) DO UPDATE SET checkin_points = EXCLUDED.checkin_points, streak_milestones = EXCLUDED.streak_milestones, updated_at = now()
         RETURNING checkin_points, streak_milestones`, [tenant, settings.checkin_points, JSON.stringify(settings.streak_milestones)]);
      return row;
    },

    // ---------- Điểm thưởng (ghi vào sổ cái, idempotent theo `key`)
    async grantBonusPoints({ tenant, customerRef, points, key, note = "", now = new Date() }) {
      const customer = await repo.findOrCreateCustomer(tenant, customerRef, {});
      if (!points) return { entry: null, replayed: false };
      return repo.appendLedger({
        tenant, customer_id: customer.id, customer_ref: customerRef, transaction_type: "bonus", points_delta: points,
        amount_minor: 0, currency: "VND", source_type: "game", source_ref: key, rule_version: 0, idempotency_key: key,
        occurred_at: now.toISOString(), metadata_json: JSON.stringify({ note }),
      });
    },
    async getBalance(tenant, customerRef) {
      const row = await one("SELECT COALESCE(SUM(points_delta), 0) AS balance FROM loyalty_ledger WHERE tenant = $1 AND customer_ref = $2", [tenant, customerRef]);
      return Number(row.balance);
    },

    // ---------- Điểm danh
    findCheckin: (tenant, ref, day) => one(`SELECT ${CHECKIN_COLS} FROM game_checkins WHERE tenant = $1 AND customer_ref = $2 AND day = $3::date`, [tenant, ref, day]),
    latestCheckinBefore: (tenant, ref, day) => one(`SELECT ${CHECKIN_COLS} FROM game_checkins WHERE tenant = $1 AND customer_ref = $2 AND day < $3::date ORDER BY day DESC LIMIT 1`, [tenant, ref, day]),
    latestCheckin: (tenant, ref) => one(`SELECT ${CHECKIN_COLS} FROM game_checkins WHERE tenant = $1 AND customer_ref = $2 ORDER BY day DESC LIMIT 1`, [tenant, ref]),
    insertCheckin: ({ tenant, customer_ref, day, points, streak }) => one(
      `INSERT INTO game_checkins (id, tenant, customer_ref, day, points, streak) VALUES ($1, $2, $3, $4::date, $5, $6)
       ON CONFLICT (tenant, customer_ref, day) DO NOTHING RETURNING ${CHECKIN_COLS}`, [newId(), tenant, customer_ref, day, points, streak]),
    listCheckinDays: async (tenant, ref, limit = 60) => (await query(
      "SELECT to_char(day, 'YYYY-MM-DD') AS day FROM game_checkins WHERE tenant = $1 AND customer_ref = $2 ORDER BY day DESC LIMIT $3", [tenant, ref, limit])).map((r) => r.day),
    async countCheckins(tenant, ref) {
      return Number((await one("SELECT COUNT(*) AS n FROM game_checkins WHERE tenant = $1 AND customer_ref = $2", [tenant, ref])).n);
    },
    insertStreakReward: ({ tenant, customer_ref, streak_start, days, points }) => one(
      `INSERT INTO game_streak_rewards (id, tenant, customer_ref, streak_start, days, points) VALUES ($1, $2, $3, $4::date, $5, $6)
       ON CONFLICT (tenant, customer_ref, streak_start, days) DO NOTHING RETURNING id`, [newId(), tenant, customer_ref, streak_start, days, points]),

    // ---------- Nhiệm vụ
    listMissions: (tenant, { includeArchived = false } = {}) => query(
      `SELECT * FROM game_missions WHERE tenant = $1 ${includeArchived ? "" : "AND status <> 'archived'"} ORDER BY sort_order, created_at`, [tenant]),
    getMission: (tenant, id) => one("SELECT * FROM game_missions WHERE tenant = $1 AND id = $2", [tenant, id]),
    createMission: (tenant, m) => one(
      `INSERT INTO game_missions (id, tenant, name, description, kind, target, reward_type, reward_points, reward_campaign_id, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [newId(), tenant, m.name, m.description || "", m.kind, m.target, m.reward_type, m.reward_points || 0, m.reward_campaign_id || null, m.status || "active", m.sort_order || 0]),
    async updateMission(tenant, id, patch) {
      const built = buildUpdate("game_missions", id, tenant, patch, ["name", "description", "kind", "target", "reward_type", "reward_points", "reward_campaign_id", "status", "sort_order"]);
      return built ? one(...built) : this.getMission(tenant, id);
    },
    /** Tiến độ trong ngày (giờ VN) của khách: số hóa đơn, tổng chi tiêu, đã điểm danh chưa. */
    async missionProgress(tenant, ref, day) {
      const [sales, checkin] = await Promise.all([
        one(`SELECT COUNT(*) AS receipts, COALESCE(SUM(amount_minor), 0) AS spend FROM loyalty_ledger
             WHERE tenant = $1 AND customer_ref = $2 AND transaction_type = 'earn' AND (occurred_at AT TIME ZONE '${TZ}')::date = $3::date`, [tenant, ref, day]),
        this.findCheckin(tenant, ref, day),
      ]);
      return { receipts: Number(sales.receipts), spend: Number(sales.spend), checkin: checkin ? 1 : 0 };
    },
    findMissionClaim: (tenant, missionId, ref, day) => one(
      "SELECT id, mission_id, customer_ref, to_char(day, 'YYYY-MM-DD') AS day, reward_type, reward_points, created_at FROM game_mission_claims WHERE tenant = $1 AND mission_id = $2 AND customer_ref = $3 AND day = $4::date",
      [tenant, missionId, ref, day]),
    listMissionClaims: (tenant, ref, day) => query(
      "SELECT mission_id FROM game_mission_claims WHERE tenant = $1 AND customer_ref = $2 AND day = $3::date", [tenant, ref, day]),
    insertMissionClaim: ({ tenant, mission_id, customer_ref, day, reward_type, reward_points }) => one(
      `INSERT INTO game_mission_claims (id, tenant, mission_id, customer_ref, day, reward_type, reward_points) VALUES ($1, $2, $3, $4, $5::date, $6, $7)
       ON CONFLICT (tenant, mission_id, customer_ref, day) DO NOTHING RETURNING id`, [newId(), tenant, mission_id, customer_ref, day, reward_type, reward_points]),
    /** Lượt chơi (lượt quay) thưởng từ nhiệm vụ: idempotent theo source_ref. */
    grantSpinEntitlement: ({ tenant, campaignId, customerRef, sourceRef, now = new Date() }) => one(
      `INSERT INTO reward_spin_entitlements (id, tenant, campaign_id, customer_ref, source_type, source_ref, status, issued_at)
       VALUES ($1, $2, $3, $4, 'mission', $5, 'available', $6)
       ON CONFLICT (tenant, campaign_id, source_type, source_ref) DO UPDATE SET source_ref = EXCLUDED.source_ref RETURNING id`,
      [newId(), tenant, campaignId, customerRef, sourceRef, now.toISOString()]),

    // ---------- Quay số may mắn
    listDraws: (tenant) => query(
      `SELECT d.*, d.created_at AS created,
         (SELECT COUNT(*) FROM game_draw_tickets t WHERE t.draw_id = d.id) AS ticket_count,
         (SELECT COUNT(DISTINCT t.customer_ref) FROM game_draw_tickets t WHERE t.draw_id = d.id) AS customer_count,
         (SELECT COUNT(*) FROM game_draw_winners w WHERE w.draw_id = d.id) AS winner_count
       FROM game_draws d WHERE d.tenant = $1 ORDER BY d.created_at DESC`, [tenant]),
    getDraw: (tenant, id) => one(`SELECT ${DRAW_COLS}, created_at AS created FROM game_draws WHERE tenant = $1 AND id = $2`, [tenant, id]),
    createDraw: (tenant, d) => one(
      `INSERT INTO game_draws (id, tenant, name, description, status, starts_at, ends_at, spend_per_ticket_minor, max_tickets_per_sale, prizes, one_prize_per_customer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING *`,
      [newId(), tenant, d.name, d.description || "", d.status || "draft", d.starts_at || null, d.ends_at || null, d.spend_per_ticket_minor, d.max_tickets_per_sale, JSON.stringify(d.prizes), d.one_prize_per_customer ?? true]),
    /** Kỳ đã quay (drawn) thì không sửa nữa: trả về null. */
    async updateDraw(tenant, id, patch) {
      const built = buildUpdate("game_draws", id, tenant, patch, ["name", "description", "status", "starts_at", "ends_at", "spend_per_ticket_minor", "max_tickets_per_sale", "prizes", "one_prize_per_customer"]);
      if (!built) return this.getDraw(tenant, id);
      return one(built[0].replace(" WHERE id = $1 AND tenant = $2", " WHERE id = $1 AND tenant = $2 AND status <> 'drawn'"), built[1]);
    },
    /** Cấp `count` vé, mỗi vé có số thứ tự liên tục theo từng kỳ. Gọi lại với cùng source thì không phát thêm. */
    async issueTickets({ tenant, drawId, customerRef, sourceType, sourceRef, count }) {
      const issued = [];
      for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        let ticket = null;
        for (let attempt = 0; attempt < 6 && !ticket; attempt += 1) {
          try {
            ticket = await one(
              `INSERT INTO game_draw_tickets (id, tenant, draw_id, ticket_no, customer_ref, source_type, source_ref, ordinal)
               SELECT $1, $2, $3, COALESCE(MAX(ticket_no), 0) + 1, $4, $5, $6, $7 FROM game_draw_tickets WHERE draw_id = $3
               RETURNING id, draw_id, ticket_no, customer_ref, created_at`,
              [newId(), tenant, drawId, customerRef, sourceType, sourceRef, ordinal]);
          } catch (error) {
            if (!isUnique(error)) throw error;
            // Trùng (draw, source, ordinal): vé đã được cấp trước đó. Trùng ticket_no: hai yêu cầu đua nhau, thử lại.
            const existing = await one(
              "SELECT id, draw_id, ticket_no, customer_ref, created_at FROM game_draw_tickets WHERE draw_id = $1 AND source_type = $2 AND source_ref = $3 AND ordinal = $4",
              [drawId, sourceType, sourceRef, ordinal]);
            if (existing) { ticket = existing; break; }
          }
        }
        if (!ticket) throw new LoyaltyConflictError("Could not allocate a ticket number. Please retry.");
        issued.push(ticket);
      }
      return issued;
    },
    /** Hóa đơn mới tự sinh vé cho các kỳ quay số đang mở. */
    async issueDrawTicketsForSale({ tenant, customerRef, sourceRef, amountMinor, occurredAt }) {
      const at = new Date(occurredAt || Date.now()).toISOString();
      const draws = await query(
        `SELECT id, spend_per_ticket_minor, max_tickets_per_sale FROM game_draws
         WHERE tenant = $1 AND status = 'open' AND spend_per_ticket_minor > 0
           AND (starts_at IS NULL OR starts_at <= $2::timestamptz) AND (ends_at IS NULL OR ends_at >= $2::timestamptz)`, [tenant, at]);
      const tickets = [];
      for (const draw of draws) {
        const count = Math.min(Math.floor(amountMinor / Number(draw.spend_per_ticket_minor)), Number(draw.max_tickets_per_sale));
        if (count > 0) tickets.push(...await this.issueTickets({ tenant, drawId: draw.id, customerRef, sourceType: "sale", sourceRef, count }));
      }
      return tickets;
    },
    listCustomerTickets: (tenant, drawId, ref) => query(
      "SELECT id, ticket_no, source_type, source_ref, created_at FROM game_draw_tickets WHERE tenant = $1 AND draw_id = $2 AND customer_ref = $3 ORDER BY ticket_no", [tenant, drawId, ref]),
    listAllTickets: (tenant, drawId) => query(
      "SELECT id, ticket_no, customer_ref FROM game_draw_tickets WHERE tenant = $1 AND draw_id = $2 ORDER BY ticket_no", [tenant, drawId]),
    listWinners: (tenant, drawId) => query(
      "SELECT id, draw_id, ticket_no, customer_ref, prize_name, prize_index, status, claimed_at, created_at FROM game_draw_winners WHERE tenant = $1 AND draw_id = $2 ORDER BY prize_index, ticket_no", [tenant, drawId]),
    /** Chốt kỳ quay và lưu người thắng trong MỘT câu lệnh: chỉ một yêu cầu thắng được trạng thái 'drawn'. */
    async commitDraw(tenant, drawId, winners) {
      return query(
        `WITH d AS (
           UPDATE game_draws SET status = 'drawn', drawn_at = now() WHERE id = $1 AND tenant = $2 AND status IN ('open', 'closed') RETURNING id
         )
         INSERT INTO game_draw_winners (id, tenant, draw_id, ticket_id, ticket_no, customer_ref, prize_name, prize_index)
         SELECT gen_random_uuid()::text, $2, d.id, w.ticket_id, w.ticket_no, w.customer_ref, w.prize_name, w.prize_index
         FROM d, jsonb_to_recordset($3::jsonb) AS w(ticket_id text, ticket_no int, customer_ref text, prize_name text, prize_index int)
         RETURNING id, ticket_no, customer_ref, prize_name, prize_index, status`, [drawId, tenant, JSON.stringify(winners)]);
    },
    async markDrawnWithoutWinners(tenant, drawId) {
      return one("UPDATE game_draws SET status = 'drawn', drawn_at = now() WHERE id = $1 AND tenant = $2 AND status IN ('open', 'closed') RETURNING id", [drawId, tenant]);
    },
    claimWinner: (tenant, drawId, winnerId) => one(
      `UPDATE game_draw_winners SET status = 'claimed', claimed_at = COALESCE(claimed_at, now())
       WHERE id = $1 AND draw_id = $2 AND tenant = $3 RETURNING id, ticket_no, customer_ref, prize_name, status, claimed_at`, [winnerId, drawId, tenant]),
  };
}
