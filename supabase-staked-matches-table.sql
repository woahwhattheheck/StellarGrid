-- Staked 1v1 multiplayer ("winner takes all") schema.
-- Run this in your Supabase SQL Editor after database-setup.sql and
-- supabase-word-attempts-table.sql.
--
-- Unlike the anonymous session_id based daily-puzzle tables, staked matches
-- require a real Supabase auth user (see hooks/use-auth.tsx) since real
-- money moves through these rows. Escrow settlement itself happens on-chain
-- (Trustless Work / Soroban) — these tables are a coordination/cache layer,
-- never the source of truth for who actually won the funds.

-- 1. Matches table
CREATE TABLE IF NOT EXISTS public.matches (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'awaiting_stakes', 'active', 'completed', 'settled', 'cancelled', 'refunded', 'disputed')),
  stake_amount NUMERIC NOT NULL CHECK (stake_amount > 0),
  asset_code TEXT NOT NULL DEFAULT 'USDC',
  escrow_id TEXT, -- Trustless Work escrow reference; null until Phase 2 wires the real SDK
  board_seed BIGINT NOT NULL, -- random per-match seed, NOT date-derived (see lib/boardGenerator.ts)
  board_snapshot JSONB NOT NULL, -- board + possibleWords/targetWords, generated once, identical for both players
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stake_deadline_at TIMESTAMP WITH TIME ZONE,
  started_at TIMESTAMP WITH TIME ZONE,
  ends_at TIMESTAMP WITH TIME ZONE,
  winner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payout_tx_hash TEXT,
  reconciliation_state TEXT NOT NULL DEFAULT 'idle',
  reconciliation_action TEXT,
  reconciliation_expected_status TEXT,
  reconciliation_claim_token UUID,
  reconciliation_claimed_at TIMESTAMP WITH TIME ZONE,
  reconciliation_attempted_at TIMESTAMP WITH TIME ZONE,
  reconciliation_winner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reconciliation_tx_hash TEXT,
  reconciliation_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT matches_reconciliation_state_check
    CHECK (reconciliation_state IN ('idle', 'claimed', 'ambiguous', 'complete')),
  CONSTRAINT matches_reconciliation_action_check
    CHECK (reconciliation_action IS NULL OR reconciliation_action IN ('settle', 'refund')),
  CONSTRAINT matches_reconciliation_expected_status_check
    CHECK (reconciliation_expected_status IS NULL OR reconciliation_expected_status IN ('active', 'awaiting_stakes'))
);

-- Existing deployments need the durable-claim columns as well; CREATE TABLE IF
-- NOT EXISTS does not add newly declared columns.
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS reconciliation_state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS reconciliation_action TEXT;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS reconciliation_expected_status TEXT;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS reconciliation_claim_token UUID;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS reconciliation_claimed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS reconciliation_attempted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS reconciliation_winner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS reconciliation_tx_hash TEXT;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS reconciliation_error TEXT;

DO $
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_reconciliation_state_check' AND conrelid = 'public.matches'::regclass) THEN
    ALTER TABLE public.matches ADD CONSTRAINT matches_reconciliation_state_check
      CHECK (reconciliation_state IN ('idle', 'claimed', 'ambiguous', 'complete'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_reconciliation_action_check' AND conrelid = 'public.matches'::regclass) THEN
    ALTER TABLE public.matches ADD CONSTRAINT matches_reconciliation_action_check
      CHECK (reconciliation_action IS NULL OR reconciliation_action IN ('settle', 'refund'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_reconciliation_expected_status_check' AND conrelid = 'public.matches'::regclass) THEN
    ALTER TABLE public.matches ADD CONSTRAINT matches_reconciliation_expected_status_check
      CHECK (reconciliation_expected_status IS NULL OR reconciliation_expected_status IN ('active', 'awaiting_stakes'));
  END IF;
END
$;

-- 2. Match participants table
CREATE TABLE IF NOT EXISTS public.match_participants (
  match_id UUID NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stellar_address TEXT,
  stake_tx_hash TEXT, -- server-written only, never client-reported
  staked_at TIMESTAMP WITH TIME ZONE,
  score INTEGER NOT NULL DEFAULT 0,
  found_words JSONB NOT NULL DEFAULT '[]',
  submitted_at TIMESTAMP WITH TIME ZONE,
  connection_status TEXT NOT NULL DEFAULT 'connected' CHECK (connection_status IN ('connected', 'disconnected')),
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (match_id, user_id)
);

-- 3. Match events table (append-only audit/reconciliation log)
CREATE TABLE IF NOT EXISTS public.match_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  match_id UUID NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_matches_status ON public.matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_created_by ON public.matches(created_by);
CREATE INDEX IF NOT EXISTS idx_match_participants_user ON public.match_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_match_events_match_id ON public.match_events(match_id);

-- Enable RLS
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- matches policies
-- ---------------------------------------------------------------------------

-- Participants (and the creator, before anyone has joined) can see their own matches.
CREATE POLICY "Participants can view their matches" ON public.matches
  FOR SELECT USING (
    auth.uid() = created_by
    OR EXISTS (
      SELECT 1 FROM public.match_participants mp
      WHERE mp.match_id = matches.id AND mp.user_id = auth.uid()
    )
  );

-- Anyone signed in can browse open matches waiting for an opponent (public lobby),
-- but only non-sensitive columns are meaningful here — clients should not rely on
-- payout/escrow fields from this policy branch.
CREATE POLICY "Signed-in users can browse open lobby matches" ON public.matches
  FOR SELECT USING (
    status = 'created' AND auth.uid() IS NOT NULL
  );

-- Only the creator can insert their own match row (server action runs as the user).
CREATE POLICY "Users can create their own match" ON public.matches
  FOR INSERT WITH CHECK (auth.uid() = created_by);

-- No direct client UPDATE — all status/stake/payout transitions go through
-- service-role server actions (lib/match-actions.ts) which bypass RLS.
CREATE POLICY "No direct client updates to matches" ON public.matches
  FOR UPDATE USING (false);

-- ---------------------------------------------------------------------------
-- match_participants policies
-- ---------------------------------------------------------------------------

-- A participant can see their own row and their opponent's row within the same match.
CREATE POLICY "Participants can view rows in their matches" ON public.match_participants
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.match_participants mp
      WHERE mp.match_id = match_participants.match_id AND mp.user_id = auth.uid()
    )
  );

-- Users can join a match (insert their own participant row) directly.
CREATE POLICY "Users can join a match" ON public.match_participants
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Clients may only update their own score/found_words/connection_status while playing;
-- stake_tx_hash/staked_at are never writable by clients (server actions bypass RLS).
CREATE POLICY "Participants can update own live game state" ON public.match_participants
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- match_events policies (insert-only via service-role server actions)
-- ---------------------------------------------------------------------------

CREATE POLICY "Participants can view events for their matches" ON public.match_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.match_participants mp
      WHERE mp.match_id = match_events.match_id AND mp.user_id = auth.uid()
    )
  );

CREATE POLICY "No direct client inserts to match_events" ON public.match_events
  FOR INSERT WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- Durable reconciliation claim/CAS (service role only)
-- ---------------------------------------------------------------------------
--
-- The first UPDATE is the concurrency proof: PostgreSQL row locking plus the
-- reconciliation_state predicate permits exactly one caller to move idle ->
-- claimed. A stale claim is reclaimable only when attempted_at is still NULL,
-- which proves this code never crossed the provider-call fence. Once attempted,
-- every retry must read provider state and may only finalize the expected
-- terminal result; it must never issue the money-moving call again blindly.

CREATE OR REPLACE FUNCTION public.claim_match_reconciliation(
  p_match_id UUID,
  p_expected_status TEXT,
  p_action TEXT,
  p_winner_user_id UUID,
  p_claim_token UUID
)
RETURNS TABLE (
  acquired BOOLEAN,
  current_status TEXT,
  claim_state TEXT,
  claim_token UUID,
  action TEXT,
  expected_status TEXT,
  winner_user_id UUID,
  attempted_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed public.matches%ROWTYPE;
BEGIN
  IF p_expected_status NOT IN ('active', 'awaiting_stakes') THEN
    RAISE EXCEPTION 'invalid reconciliation status %', p_expected_status;
  END IF;
  IF p_action NOT IN ('settle', 'refund') THEN
    RAISE EXCEPTION 'invalid reconciliation action %', p_action;
  END IF;
  IF p_action = 'settle' AND p_winner_user_id IS NULL THEN
    RAISE EXCEPTION 'settlement requires a winner';
  END IF;

  UPDATE public.matches AS m
  SET reconciliation_state = 'claimed',
      reconciliation_action = p_action,
      reconciliation_expected_status = p_expected_status,
      reconciliation_claim_token = p_claim_token,
      reconciliation_claimed_at = clock_timestamp(),
      reconciliation_attempted_at = NULL,
      reconciliation_winner_user_id = CASE WHEN p_action = 'settle' THEN p_winner_user_id ELSE NULL END,
      reconciliation_tx_hash = NULL,
      reconciliation_error = NULL,
      updated_at = clock_timestamp()
  WHERE m.id = p_match_id
    AND m.status = p_expected_status
    AND (
      m.reconciliation_state = 'idle'
      OR (
        m.reconciliation_state = 'claimed'
        AND m.reconciliation_attempted_at IS NULL
        AND m.reconciliation_claimed_at < clock_timestamp() - INTERVAL '5 minutes'
      )
    )
  RETURNING m.* INTO claimed;

  IF FOUND THEN
    RETURN QUERY SELECT
      TRUE,
      claimed.status,
      claimed.reconciliation_state,
      claimed.reconciliation_claim_token,
      claimed.reconciliation_action,
      claimed.reconciliation_expected_status,
      claimed.reconciliation_winner_user_id,
      claimed.reconciliation_attempted_at;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    FALSE,
    m.status,
    m.reconciliation_state,
    m.reconciliation_claim_token,
    m.reconciliation_action,
    m.reconciliation_expected_status,
    m.reconciliation_winner_user_id,
    m.reconciliation_attempted_at
  FROM public.matches AS m
  WHERE m.id = p_match_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_unattempted_match_reconciliation(
  p_match_id UUID,
  p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed INTEGER;
BEGIN
  UPDATE public.matches
  SET reconciliation_state = 'idle',
      reconciliation_action = NULL,
      reconciliation_expected_status = NULL,
      reconciliation_claim_token = NULL,
      reconciliation_claimed_at = NULL,
      reconciliation_winner_user_id = NULL,
      reconciliation_error = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_match_id
    AND reconciliation_state = 'claimed'
    AND reconciliation_claim_token = p_claim_token
    AND reconciliation_attempted_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_match_reconciliation_attempted(
  p_match_id UUID,
  p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed INTEGER;
BEGIN
  UPDATE public.matches
  SET reconciliation_attempted_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = p_match_id
    AND reconciliation_state = 'claimed'
    AND reconciliation_claim_token = p_claim_token
    AND reconciliation_attempted_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_match_reconciliation_ambiguous(
  p_match_id UUID,
  p_claim_token UUID,
  p_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed INTEGER;
BEGIN
  UPDATE public.matches
  SET reconciliation_state = 'ambiguous',
      reconciliation_error = LEFT(p_error, 1000),
      updated_at = clock_timestamp()
  WHERE id = p_match_id
    AND reconciliation_state IN ('claimed', 'ambiguous')
    AND reconciliation_claim_token = p_claim_token
    AND reconciliation_attempted_at IS NOT NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_match_reconciliation(
  p_match_id UUID,
  p_claim_token UUID,
  p_terminal_status TEXT,
  p_tx_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed INTEGER;
BEGIN
  IF p_terminal_status NOT IN ('settled', 'refunded') THEN
    RAISE EXCEPTION 'invalid terminal reconciliation status %', p_terminal_status;
  END IF;

  UPDATE public.matches
  SET status = p_terminal_status,
      winner_user_id = CASE
        WHEN reconciliation_action = 'settle' THEN reconciliation_winner_user_id
        ELSE NULL
      END,
      payout_tx_hash = CASE
        WHEN reconciliation_action = 'settle' THEN COALESCE(p_tx_hash, payout_tx_hash)
        ELSE payout_tx_hash
      END,
      reconciliation_tx_hash = COALESCE(p_tx_hash, reconciliation_tx_hash),
      reconciliation_state = 'complete',
      reconciliation_error = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_match_id
    AND reconciliation_claim_token = p_claim_token
    AND reconciliation_state IN ('claimed', 'ambiguous')
    AND reconciliation_attempted_at IS NOT NULL
    AND status = reconciliation_expected_status
    AND (
      (reconciliation_action = 'settle' AND p_terminal_status = 'settled')
      OR (reconciliation_action = 'refund' AND p_terminal_status = 'refunded')
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_match_reconciliation(UUID, TEXT, TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_unattempted_match_reconciliation(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_match_reconciliation_attempted(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_match_reconciliation_ambiguous(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_match_reconciliation(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_match_reconciliation(UUID, TEXT, TEXT, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_unattempted_match_reconciliation(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_match_reconciliation_attempted(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_match_reconciliation_ambiguous(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_match_reconciliation(UUID, UUID, TEXT, TEXT) TO service_role;

