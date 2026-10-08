"use server"

import { randomUUID } from "node:crypto"
import { supabase } from "@/lib/supabase"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getEscrowClient } from "@/lib/soroban/escrowClient"
import { assessRecoveredProviderOutcome } from "@/lib/reconciliation-recovery-policy.mjs"
import { generateRandomSeed, generateBoardFromSeed } from "@/lib/boardGenerator"
import { words3 } from "@/utils/words3"
import { obfuscateWords } from "@/utils/wordObfuscation"

// Server actions for the staked 1v1 "winner takes all" match lifecycle.
// These mirror the pattern in lib/actions.ts (plain Supabase client calls
// wrapped in try/catch, { success, data|error } return shape) but write
// money-adjacent columns (stake_tx_hash, winner_user_id, payout_tx_hash)
// through supabaseAdmin (service role), which RLS otherwise blocks direct
// client writes to. See supabase-staked-matches-table.sql for the schema
// and RLS policies this respects.
//
// Anti-cheat note: submitted scores/found_words are trusted as-is in this
// Phase 1 slice, same trust level as the existing daily-game flow. Re-validating
// submissions against board_snapshot server-side before settlement is tracked
// as a follow-up contributor issue ("Anti-cheat hardening").

const MATCH_DURATION_MS = 3 * 60 * 1000 // 3 minutes per match
const STAKE_WINDOW_MS = 2 * 60 * 1000 // 2 minutes to both stake before refund-eligible

export interface BoardSnapshot {
  board: string[][]
  possibleWords: string
  targetWords: string
  totalPossibleWords: number
}

function buildBoardSnapshot(): { boardSeed: number; snapshot: BoardSnapshot } {
  const boardSeed = generateRandomSeed()
  const result = generateBoardFromSeed(boardSeed, words3, 50)
  const targetWords = result.allWords.slice(0, 50)
  // Obfuscation key must be reproducible by the client later, so it's keyed
  // off the persisted board_seed (not a throwaway value) — the client reads
  // matches.board_seed alongside board_snapshot to deobfuscate.
  const obfuscationKey = String(boardSeed)

  return {
    boardSeed,
    snapshot: {
      board: result.board,
      possibleWords: obfuscateWords(result.allWords, obfuscationKey),
      targetWords: obfuscateWords(targetWords, obfuscationKey),
      totalPossibleWords: Math.min(result.wordCount, 50),
    },
  }
}

async function logMatchEvent(matchId: string, eventType: string, payload: Record<string, unknown> = {}) {
  await supabaseAdmin.from("match_events").insert({ match_id: matchId, event_type: eventType, payload })
}

export async function createMatch(userId: string, stakeAmount: number) {
  try {
    const { boardSeed, snapshot } = buildBoardSnapshot()

    const { data, error } = await supabase
      .from("matches")
      .insert({
        status: "created",
        stake_amount: stakeAmount,
        asset_code: "USDC",
        board_seed: boardSeed,
        board_snapshot: snapshot,
        created_by: userId,
      })
      .select()
      .single()

    if (error) {
      console.error("Error creating match:", error)
      return { success: false, error: error.message }
    }

    await supabase.from("match_participants").insert({ match_id: data.id, user_id: userId })
    await logMatchEvent(data.id, "created", { userId, stakeAmount })

    return { success: true, data }
  } catch (error) {
    console.error("Error in createMatch:", error)
    return { success: false, error: "Failed to create match" }
  }
}

export async function joinMatch(matchId: string, userId: string) {
  try {
    const { data: match, error: matchError } = await supabase.from("matches").select("*").eq("id", matchId).single()

    if (matchError || !match) {
      return { success: false, error: "Match not found" }
    }
    if (match.status !== "created") {
      return { success: false, error: "Match is no longer accepting players" }
    }
    if (match.created_by === userId) {
      return { success: false, error: "Cannot join your own match" }
    }

    const { error: joinError } = await supabase
      .from("match_participants")
      .insert({ match_id: matchId, user_id: userId })

    if (joinError) {
      return { success: false, error: joinError.message }
    }

    const stakeDeadline = new Date(Date.now() + STAKE_WINDOW_MS).toISOString()

    const escrowClient = await getEscrowClient()
    const { escrowId } = await escrowClient.createMatch({
      matchId,
      playerA: match.created_by,
      playerB: userId,
      stakeAmount: String(match.stake_amount),
      asset: "USDC",
    })

    const { data, error } = await supabaseAdmin
      .from("matches")
      .update({ status: "awaiting_stakes", stake_deadline_at: stakeDeadline, escrow_id: escrowId })
      .eq("id", matchId)
      .select()
      .single()

    if (error) {
      return { success: false, error: error.message }
    }

    await logMatchEvent(matchId, "opponent_joined", { userId })

    return { success: true, data }
  } catch (error) {
    console.error("Error in joinMatch:", error)
    return { success: false, error: "Failed to join match" }
  }
}

export async function confirmStake(matchId: string, userId: string) {
  try {
    const escrowClient = await getEscrowClient()

    const { xdr } = await escrowClient.buildDepositTx(matchId, userId)
    const { txHash } = await escrowClient.submitSignedTx(xdr)
    const escrowState = await escrowClient.getMatchState(matchId)

    // Server verifies the on-chain (or mock) deposit before trusting it — the
    // client never gets to self-report stake_tx_hash/staked_at directly.
    const { error: participantError } = await supabaseAdmin
      .from("match_participants")
      .update({ stake_tx_hash: txHash, staked_at: new Date().toISOString() })
      .eq("match_id", matchId)
      .eq("user_id", userId)

    if (participantError) {
      return { success: false, error: participantError.message }
    }

    await logMatchEvent(matchId, "staked", { userId, txHash })

    if (escrowState.status === "Funded") {
      const startedAt = new Date()
      const endsAt = new Date(startedAt.getTime() + MATCH_DURATION_MS)

      const { data, error } = await supabaseAdmin
        .from("matches")
        .update({ status: "active", started_at: startedAt.toISOString(), ends_at: endsAt.toISOString() })
        .eq("id", matchId)
        .eq("status", "awaiting_stakes")
        .eq("reconciliation_state", "idle")
        .select()
        .single()

      if (error) {
        return { success: false, error: error.message }
      }

      await logMatchEvent(matchId, "match_started", { startedAt, endsAt })
      return { success: true, data, escrowState }
    }

    return { success: true, escrowState }
  } catch (error) {
    console.error("Error in confirmStake:", error)
    return { success: false, error: "Failed to confirm stake" }
  }
}

export async function submitScore(
  matchId: string,
  userId: string,
  score: number,
  foundWords: string[],
) {
  try {
    const { error: submitError } = await supabaseAdmin
      .from("match_participants")
      .update({ score, found_words: foundWords, submitted_at: new Date().toISOString() })
      .eq("match_id", matchId)
      .eq("user_id", userId)

    if (submitError) {
      return { success: false, error: submitError.message }
    }

    await logMatchEvent(matchId, "submitted", { userId, score })

    const { data: participants, error: fetchError } = await supabaseAdmin
      .from("match_participants")
      .select("*")
      .eq("match_id", matchId)

    if (fetchError || !participants) {
      return { success: false, error: fetchError?.message ?? "Could not load participants" }
    }

    const { data: match } = await supabaseAdmin.from("matches").select("*").eq("id", matchId).single()
    if (!match) {
      return { success: false, error: "Match not found" }
    }

    const bothSubmitted = participants.length === 2 && participants.every((p) => p.submitted_at)
    const timerExpired = match.ends_at && new Date(match.ends_at) < new Date()

    if ((bothSubmitted || timerExpired) && match.status === "active") {
      return await settleMatch(matchId)
    }

    return { success: true }
  } catch (error) {
    console.error("Error in submitScore:", error)
    return { success: false, error: "Failed to submit score" }
  }
}

type ReconciliationAction = "settle" | "refund"
type ReconciliationExpectedStatus = "active" | "awaiting_stakes"

interface ReconciliationClaim {
  acquired: boolean
  current_status: string
  claim_state: "idle" | "claimed" | "ambiguous" | "complete"
  claim_token: string | null
  action: ReconciliationAction | null
  expected_status: ReconciliationExpectedStatus | null
  winner_user_id: string | null
  attempted_at: string | null
}

function rpcReturnedTrue(data: unknown): boolean {
  return data === true || (Array.isArray(data) && data[0] === true)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function claimReconciliation(
  matchId: string,
  expectedStatus: ReconciliationExpectedStatus,
  action: ReconciliationAction,
  winnerUserId: string | null,
): Promise<ReconciliationClaim> {
  const claimToken = randomUUID()
  const { data, error } = await supabaseAdmin.rpc("claim_match_reconciliation", {
    p_match_id: matchId,
    p_expected_status: expectedStatus,
    p_action: action,
    p_winner_user_id: winnerUserId,
    p_claim_token: claimToken,
  })

  if (error) {
    throw new Error(`Failed to claim reconciliation: ${error.message}`)
  }

  const row = (Array.isArray(data) ? data[0] : data) as ReconciliationClaim | null
  if (!row) {
    throw new Error("Failed to claim reconciliation: match not found")
  }
  return row
}

async function releaseUnattemptedClaim(matchId: string, claimToken: string): Promise<void> {
  await supabaseAdmin.rpc("release_unattempted_match_reconciliation", {
    p_match_id: matchId,
    p_claim_token: claimToken,
  })
}

async function markClaimAttempted(matchId: string, claimToken: string): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabaseAdmin.rpc("mark_match_reconciliation_attempted", {
    p_match_id: matchId,
    p_claim_token: claimToken,
  })
  if (error) return { success: false, error: error.message }
  return { success: rpcReturnedTrue(data) }
}

async function markClaimAmbiguous(matchId: string, claimToken: string, error: string): Promise<void> {
  await supabaseAdmin.rpc("mark_match_reconciliation_ambiguous", {
    p_match_id: matchId,
    p_claim_token: claimToken,
    p_error: error.slice(0, 1000),
  })
}

function claimEventType(claim: ReconciliationClaim): string {
  if (claim.action === "settle") return "settled"
  return claim.expected_status === "awaiting_stakes" ? "stake_deadline_refunded" : "tie_refunded"
}

async function completeClaim(
  matchId: string,
  claim: ReconciliationClaim,
  txHash: string | null,
  recovered: boolean,
) {
  if (!claim.claim_token || !claim.action) {
    return { success: false, error: "Reconciliation claim metadata is incomplete" }
  }

  const terminalStatus = claim.action === "settle" ? "settled" : "refunded"
  const { data, error } = await supabaseAdmin.rpc("complete_match_reconciliation", {
    p_match_id: matchId,
    p_claim_token: claim.claim_token,
    p_terminal_status: terminalStatus,
    p_tx_hash: txHash,
  })

  if (error || !rpcReturnedTrue(data)) {
    const message = error?.message ?? "Reconciliation claim no longer owns finalization"
    await markClaimAmbiguous(matchId, claim.claim_token, `Provider completed but DB finalization failed: ${message}`)
    return {
      success: false,
      reconciliationPending: true,
      error: "Provider outcome requires database reconciliation; automatic resubmission is disabled",
    }
  }

  await logMatchEvent(matchId, claimEventType(claim), {
    winnerUserId: claim.winner_user_id,
    txHash,
    recovered,
  })

  const { data: match } = await supabaseAdmin.from("matches").select("*").eq("id", matchId).single()
  return { success: true, data: match, recovered }
}

async function recoverProviderOutcome(matchId: string, claim: ReconciliationClaim) {
  if (!claim.claim_token || !claim.action || !claim.attempted_at) {
    return { success: true, alreadyReconciling: true }
  }

  try {
    const escrowClient = await getEscrowClient()
    const providerState = await escrowClient.getMatchState(matchId)
    const assessment = assessRecoveredProviderOutcome(
      { action: claim.action, winnerUserId: claim.winner_user_id },
      { status: providerState.status, winner: providerState.winner },
    )

    if (!assessment.canFinalize) {
      await markClaimAmbiguous(matchId, claim.claim_token, assessment.reason)
      return {
        success: false,
        reconciliationPending: true,
        providerStatus: providerState.status,
        error: assessment.reason,
      }
    }

    return await completeClaim(matchId, claim, providerState.txHash ?? null, true)
  } catch (error) {
    await markClaimAmbiguous(matchId, claim.claim_token, `Provider state read failed: ${describeError(error)}`)
    return {
      success: false,
      reconciliationPending: true,
      error: "Provider state could not be verified; automatic resubmission is disabled",
    }
  }
}

async function executeClaimedOperation(matchId: string, claim: ReconciliationClaim) {
  if (!claim.claim_token || !claim.action) {
    return { success: false, error: "Reconciliation claim metadata is incomplete" }
  }

  let escrowClient
  try {
    escrowClient = await getEscrowClient()
  } catch (error) {
    await releaseUnattemptedClaim(matchId, claim.claim_token)
    return { success: false, error: describeError(error) }
  }

  const attempted = await markClaimAttempted(matchId, claim.claim_token)
  if (!attempted.success) {
    // No provider call has happened. Release succeeds only when the attempted
    // marker definitely did not commit; an uncertain committed marker stays
    // held for provider-state recovery rather than risking a duplicate call.
    await releaseUnattemptedClaim(matchId, claim.claim_token)
    return {
      success: false,
      reconciliationPending: true,
      error: attempted.error ?? "Could not durably mark the provider attempt",
    }
  }

  try {
    const result = claim.action === "settle"
      ? await escrowClient.settle(matchId, claim.winner_user_id as string)
      : await escrowClient.refundTimeout(matchId)
    return await completeClaim(matchId, claim, result.txHash, false)
  } catch (error) {
    await markClaimAmbiguous(matchId, claim.claim_token, `Provider call outcome is ambiguous: ${describeError(error)}`)
    return {
      success: false,
      reconciliationPending: true,
      error: "Provider call outcome is ambiguous; automatic resubmission is disabled",
    }
  }
}

async function runMatchReconciliation(
  matchId: string,
  expectedStatus: ReconciliationExpectedStatus,
  action: ReconciliationAction,
  winnerUserId: string | null,
) {
  const claim = await claimReconciliation(matchId, expectedStatus, action, winnerUserId)

  if (claim.acquired) {
    return await executeClaimedOperation(matchId, claim)
  }

  if (claim.current_status === "settled" || claim.current_status === "refunded") {
    return { success: true, alreadySettled: true }
  }

  if (claim.current_status !== expectedStatus) {
    return { success: true, noActionNeeded: true }
  }

  if (claim.claim_state === "claimed" && !claim.attempted_at) {
    // A concurrent caller owns the short pre-provider window. Only claims that
    // never reached the attempted marker can be reclaimed after the DB-enforced
    // stale interval.
    return { success: true, alreadyReconciling: true }
  }

  return await recoverProviderOutcome(matchId, claim)
}

export async function settleMatch(matchId: string) {
  const { data: existing } = await supabaseAdmin.from("matches").select("status").eq("id", matchId).single()
  if (existing && (existing.status === "settled" || existing.status === "refunded")) {
    return { success: true, alreadySettled: true }
  }

  const { data: participants, error: fetchError } = await supabaseAdmin
    .from("match_participants")
    .select("*")
    .eq("match_id", matchId)

  if (fetchError || !participants || participants.length !== 2) {
    return { success: false, error: "Cannot settle: expected exactly two participants" }
  }

  const [a, b] = participants
  const winner = a.score === b.score ? null : a.score > b.score ? a : b
  return await runMatchReconciliation(
    matchId,
    "active",
    winner ? "settle" : "refund",
    winner?.user_id ?? null,
  )
}

export async function getMatch(matchId: string) {
  try {
    const { data: match, error: matchError } = await supabase.from("matches").select("*").eq("id", matchId).single()

    if (matchError) {
      return { success: false, error: matchError.message }
    }

    const { data: participants, error: participantsError } = await supabase
      .from("match_participants")
      .select("*")
      .eq("match_id", matchId)

    if (participantsError) {
      return { success: false, error: participantsError.message }
    }

    return { success: true, data: { match, participants } }
  } catch (error) {
    console.error("Error in getMatch:", error)
    return { success: false, error: "Failed to load match" }
  }
}

/**
 * Sweeps a single match for stuck states that the normal client-driven flow
 * didn't resolve: an active match whose timer expired but neither player's
 * client called submitScore (e.g. both tabs closed), or an awaiting_stakes
 * match past its stake deadline with fewer than two deposits confirmed.
 * Safe to call repeatedly — see settleMatch's idempotency guard above.
 */
export async function reconcileMatch(matchId: string) {
  try {
    const { data: match, error } = await supabaseAdmin.from("matches").select("*").eq("id", matchId).single()
    if (error || !match) {
      return { success: false, error: error?.message ?? "Match not found" }
    }

    if (match.status === "active" && match.ends_at && new Date(match.ends_at) < new Date()) {
      return await settleMatch(matchId)
    }

    if (
      match.status === "awaiting_stakes" &&
      match.stake_deadline_at &&
      new Date(match.stake_deadline_at) < new Date()
    ) {
      const { data: participants } = await supabaseAdmin
        .from("match_participants")
        .select("*")
        .eq("match_id", matchId)

      const bothStaked = participants?.length === 2 && participants.every((p) => p.staked_at)
      if (!bothStaked) {
        return await runMatchReconciliation(matchId, "awaiting_stakes", "refund", null)
      }
    }

    return { success: true, data: match, noActionNeeded: true }
  } catch (error) {
    console.error("Error in reconcileMatch:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to reconcile match",
    }
  }
}

export async function listOpenMatches() {
  try {
    const { data, error } = await supabase
      .from("matches")
      .select("id, stake_amount, asset_code, created_by, created_at")
      .eq("status", "created")
      .order("created_at", { ascending: false })
      .limit(20)

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, data }
  } catch (error) {
    console.error("Error in listOpenMatches:", error)
    return { success: false, error: "Failed to list open matches" }
  }
}
