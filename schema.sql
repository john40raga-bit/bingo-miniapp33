-- ============================================================
-- AVIATOR GAME - Database Schema
-- PostgreSQL
-- ============================================================

-- Users (synced from Telegram)
CREATE TABLE users (
  telegram_id     BIGINT PRIMARY KEY,
  username        VARCHAR(64),
  first_name      VARCHAR(128),
  balance         BIGINT DEFAULT 0,         -- stored in cents
  total_wagered   BIGINT DEFAULT 0,
  total_won       BIGINT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
  is_banned       BOOLEAN DEFAULT FALSE,
  ban_reason      TEXT
);

CREATE INDEX idx_users_balance ON users(balance DESC);

-- Game Rounds (one per game cycle)
CREATE TABLE rounds (
  id              SERIAL PRIMARY KEY,
  server_seed     VARCHAR(64),              -- revealed AFTER crash (provably fair)
  server_seed_hash VARCHAR(64) NOT NULL,    -- shown BEFORE round starts
  client_seed     VARCHAR(64) NOT NULL,
  nonce           BIGINT NOT NULL,
  crash_point     DECIMAL(10, 2) NOT NULL,
  phase           VARCHAR(20) NOT NULL DEFAULT 'betting',
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);

CREATE INDEX idx_rounds_started_at ON rounds(started_at DESC);
CREATE INDEX idx_rounds_phase ON rounds(phase);

-- Bets
CREATE TABLE bets (
  id              SERIAL PRIMARY KEY,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  user_id         BIGINT NOT NULL REFERENCES users(telegram_id),
  amount          BIGINT NOT NULL,          -- in cents
  auto_cashout    DECIMAL(10, 2),           -- optional auto-cashout multiplier
  cashout_multiplier DECIMAL(10, 2),        -- actual cashout multiplier (if won)
  winnings        BIGINT,                   -- in cents (null if lost)
  result          VARCHAR(10),              -- 'won' | 'lost' | null
  placed_at       TIMESTAMPTZ DEFAULT NOW(),
  settled_at      TIMESTAMPTZ,
  UNIQUE(round_id, user_id)
);

CREATE INDEX idx_bets_user_id ON bets(user_id);
CREATE INDEX idx_bets_round_id ON bets(round_id);
CREATE INDEX idx_bets_placed_at ON bets(placed_at DESC);

-- Transactions (deposits / withdrawals)
CREATE TABLE transactions (
  id              SERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(telegram_id),
  type            VARCHAR(20) NOT NULL,     -- 'deposit' | 'withdrawal' | 'bonus'
  amount          BIGINT NOT NULL,          -- in cents (positive = credit)
  method          VARCHAR(50),              -- 'telegram_stars' | 'ton' | 'crypto'
  details         JSONB,                    -- payment provider details
  reference       VARCHAR(128) UNIQUE,      -- external transaction ID
  status          VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'complete' | 'failed'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_status ON transactions(status);

-- Daily stats (for analytics)
CREATE TABLE daily_stats (
  date            DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  total_rounds    INTEGER DEFAULT 0,
  total_bets      INTEGER DEFAULT 0,
  total_wagered   BIGINT DEFAULT 0,
  total_paid_out  BIGINT DEFAULT 0,
  unique_players  INTEGER DEFAULT 0,
  house_profit    BIGINT DEFAULT 0
);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Get user stats
CREATE OR REPLACE FUNCTION get_user_stats(p_telegram_id BIGINT)
RETURNS TABLE (
  total_bets BIGINT,
  total_wagered BIGINT,
  total_won BIGINT,
  net_profit BIGINT,
  biggest_win BIGINT,
  best_multiplier DECIMAL
) AS $$
  SELECT
    COUNT(*),
    COALESCE(SUM(amount), 0),
    COALESCE(SUM(CASE WHEN result = 'won' THEN winnings ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN result = 'won' THEN winnings - amount ELSE -amount END), 0),
    COALESCE(MAX(CASE WHEN result = 'won' THEN winnings - amount ELSE 0 END), 0),
    COALESCE(MAX(cashout_multiplier), 0)
  FROM bets WHERE user_id = p_telegram_id;
$$ LANGUAGE SQL;

-- ============================================================
-- SAMPLE INDEXES FOR PERFORMANCE
-- ============================================================

-- Leaderboard query optimization
CREATE INDEX idx_bets_result ON bets(result) WHERE result IS NOT NULL;

-- Recent activity feed
CREATE INDEX idx_bets_settled_at ON bets(settled_at DESC) WHERE settled_at IS NOT NULL;
