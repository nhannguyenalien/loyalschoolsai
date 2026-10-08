-- Loyalty + Reward World trên Postgres (Neon). Chạy lại nhiều lần an toàn.
CREATE TABLE IF NOT EXISTS loyalty_programs (
  id text PRIMARY KEY, tenant text NOT NULL, version int NOT NULL,
  currency text NOT NULL DEFAULT 'VND', spend_per_point_minor bigint NOT NULL, points_per_step int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, version)
);
CREATE INDEX IF NOT EXISTS idx_program_active ON loyalty_programs (tenant, status, version);

CREATE TABLE IF NOT EXISTS loyalty_customers (
  id text PRIMARY KEY, tenant text NOT NULL, customer_ref text NOT NULL,
  name text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active',
  metadata_json text NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, customer_ref)
);
CREATE INDEX IF NOT EXISTS idx_customer_phone ON loyalty_customers (tenant, phone);

-- Sổ cái chỉ ghi thêm: số dư = SUM(points_delta).
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id text PRIMARY KEY, tenant text NOT NULL, customer_id text NOT NULL REFERENCES loyalty_customers(id),
  customer_ref text NOT NULL, transaction_type text NOT NULL, points_delta bigint NOT NULL,
  amount_minor bigint NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT 'VND',
  source_type text NOT NULL, source_ref text NOT NULL, rule_version int NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  reverses_entry_id text, metadata_json text NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, idempotency_key),
  UNIQUE (tenant, source_type, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON loyalty_ledger (tenant, customer_id, created_at);

CREATE TABLE IF NOT EXISTS reward_campaigns (
  id text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft', starts_at timestamptz, ends_at timestamptz,
  spend_per_spin_minor bigint NOT NULL, max_spins_per_sale int NOT NULL DEFAULT 1,
  theme_json text NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaign_status ON reward_campaigns (status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS reward_campaign_prizes (
  id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES reward_campaigns(id),
  name text NOT NULL, prize_type text NOT NULL, weight numeric NOT NULL,
  max_wins int NOT NULL DEFAULT 0, sort_order int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active', value_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prize_campaign ON reward_campaign_prizes (campaign_id, status, sort_order);

CREATE TABLE IF NOT EXISTS reward_store_joins (
  id text PRIMARY KEY, tenant text NOT NULL, campaign_id text NOT NULL REFERENCES reward_campaigns(id),
  status text NOT NULL DEFAULT 'active', joined_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant, campaign_id)
);

CREATE TABLE IF NOT EXISTS reward_spin_entitlements (
  id text PRIMARY KEY, tenant text NOT NULL, campaign_id text NOT NULL, customer_ref text NOT NULL,
  source_type text NOT NULL, source_ref text NOT NULL, status text NOT NULL DEFAULT 'available',
  issued_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, campaign_id, source_type, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_entitlement_customer ON reward_spin_entitlements (tenant, campaign_id, customer_ref, status, created_at);

CREATE TABLE IF NOT EXISTS reward_spin_results (
  id text PRIMARY KEY, tenant text NOT NULL, campaign_id text NOT NULL, customer_ref text NOT NULL,
  entitlement_id text NOT NULL UNIQUE, prize_id text NOT NULL, prize_name text NOT NULL,
  prize_type text NOT NULL, prize_value_json text NOT NULL DEFAULT '{}',
  prize_slot_key text NOT NULL UNIQUE, idempotency_key text NOT NULL,
  status text NOT NULL, spun_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_result_prize ON reward_spin_results (prize_id, status);

CREATE TABLE IF NOT EXISTS reward_claims (
  id text PRIMARY KEY, tenant text NOT NULL, campaign_id text NOT NULL, result_id text NOT NULL UNIQUE,
  customer_ref text NOT NULL, prize_id text NOT NULL, prize_name text NOT NULL, prize_type text NOT NULL,
  prize_value_json text NOT NULL DEFAULT '{}', claim_note text NOT NULL DEFAULT '',
  claimed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claim_customer ON reward_claims (tenant, customer_ref, claimed_at);

-- API key cho POS/hệ thống ngoài. Chỉ lưu hash SHA-256; key gốc chỉ hiện một lần khi tạo.
CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY, tenant text NOT NULL, name text NOT NULL,
  key_prefix text NOT NULL, key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant, revoked_at);

-- ===================== Game giữ chân & quay số (theo cửa hàng) =====================
-- Cấu hình điểm danh + mốc chuỗi (1 dòng / cửa hàng).
CREATE TABLE IF NOT EXISTS game_settings (
  tenant text PRIMARY KEY, checkin_points int NOT NULL DEFAULT 10,
  streak_milestones jsonb NOT NULL DEFAULT '[{"days":7,"points":50},{"days":14,"points":120},{"days":30,"points":300}]',
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Mỗi khách một lần điểm danh mỗi ngày (ngày theo giờ Việt Nam).
CREATE TABLE IF NOT EXISTS game_checkins (
  id text PRIMARY KEY, tenant text NOT NULL, customer_ref text NOT NULL, day date NOT NULL,
  points int NOT NULL DEFAULT 0, streak int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, customer_ref, day)
);
CREATE INDEX IF NOT EXISTS idx_checkins_customer ON game_checkins (tenant, customer_ref, day DESC);
-- Thưởng mốc chuỗi: mỗi mốc chỉ nhận một lần trong một chuỗi (streak_start = ngày bắt đầu chuỗi).
CREATE TABLE IF NOT EXISTS game_streak_rewards (
  id text PRIMARY KEY, tenant text NOT NULL, customer_ref text NOT NULL, streak_start date NOT NULL,
  days int NOT NULL, points int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, customer_ref, streak_start, days)
);

CREATE TABLE IF NOT EXISTS game_missions (
  id text PRIMARY KEY, tenant text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
  kind text NOT NULL,                    -- checkin | receipts | spend
  target bigint NOT NULL DEFAULT 1,
  reward_type text NOT NULL,             -- points | spin
  reward_points int NOT NULL DEFAULT 0, reward_campaign_id text,
  status text NOT NULL DEFAULT 'active', -- active | paused | archived
  sort_order int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_missions_tenant ON game_missions (tenant, status, sort_order);
CREATE TABLE IF NOT EXISTS game_mission_claims (
  id text PRIMARY KEY, tenant text NOT NULL, mission_id text NOT NULL, customer_ref text NOT NULL, day date NOT NULL,
  reward_type text NOT NULL, reward_points int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, mission_id, customer_ref, day)
);

CREATE TABLE IF NOT EXISTS game_draws (
  id text PRIMARY KEY, tenant text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',  -- draft | open | closed | drawn
  starts_at timestamptz, ends_at timestamptz,
  spend_per_ticket_minor bigint NOT NULL DEFAULT 0, max_tickets_per_sale int NOT NULL DEFAULT 1,
  prizes jsonb NOT NULL DEFAULT '[]',    -- [{ "name": "...", "quantity": 1 }]
  one_prize_per_customer boolean NOT NULL DEFAULT true,
  drawn_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_draws_tenant ON game_draws (tenant, status, created_at DESC);
CREATE TABLE IF NOT EXISTS game_draw_tickets (
  id text PRIMARY KEY, tenant text NOT NULL, draw_id text NOT NULL REFERENCES game_draws(id),
  ticket_no int NOT NULL, customer_ref text NOT NULL, source_type text NOT NULL, source_ref text NOT NULL,
  ordinal int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draw_id, ticket_no),
  UNIQUE (draw_id, source_type, source_ref, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_tickets_customer ON game_draw_tickets (tenant, draw_id, customer_ref);
CREATE TABLE IF NOT EXISTS game_draw_winners (
  id text PRIMARY KEY, tenant text NOT NULL, draw_id text NOT NULL REFERENCES game_draws(id),
  ticket_id text NOT NULL, ticket_no int NOT NULL, customer_ref text NOT NULL,
  prize_name text NOT NULL, prize_index int NOT NULL, status text NOT NULL DEFAULT 'won',
  claimed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draw_id, ticket_id)
);

-- Mini-game dùng chung lượt quay: ghi lại cách trình bày (wheel | cards | dice | slot).
ALTER TABLE reward_spin_results ADD COLUMN IF NOT EXISTS game text NOT NULL DEFAULT 'wheel';
