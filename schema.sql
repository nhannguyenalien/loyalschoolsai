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
