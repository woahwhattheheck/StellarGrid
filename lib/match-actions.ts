"use server"

import { supabase } from "@/lib/supabase"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { broadcastMatchTransition } from "@/lib/match-realtime"
import { getEscrowClient } from "@/lib/soroban/escrowClient"
import { generateRandomSeed, generateBoardFromSeed, findWordsOnBoard } from "@/lib/boardGenerator"
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
// Final submitScore() still records the client score in this slice. Live
// progress used by timeout settlement is revalidated in syncLiveMatchProgress
// against the persisted board before score/found_words are written.
// MIN_MATCH_WORD_LENGTH, normalizeSubmittedWords, scoreMatchWords, and
// findWordsOnBoard match the staked-match submit validator so the two paths
// can be deduplicated when that change lands.

const MATCH_DURATION_MS = 3 * 60 * 1000 // 3 minutes per match
const STAKE_WINDOW_MS = 2 * 60 * 1000 // 2 minutes to both stake before refund-eligible
const MIN_MATCH_WORD_LENGTH = 4

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
    await broadcastMatchTransition(matchId, "opponent_joined", { userId, status: "awaiting_stakes" })

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
    await broadcastMatchTransition(matchId, "stake_confirmed", { userId })

    if (escrowState.status === "Funded") {
      const startedAt = new Date()
      const endsAt = new Date(startedAt.getTime() + MATCH_DURATION_MS)

      const { data, error } = await supabaseAdmin
        .from("matches")
        .update({ status: "active", started_at: startedAt.toISOString(), ends_at: endsAt.toISOString() })
        .eq("id", matchId)
        .select()
        .single()

      if (error) {
        return { success: false, error: error.message }
      }

      await logMatchEvent(matchId, "match_started", { startedAt, endsAt })
      await broadcastMatchTransition(matchId, "match_started", {
        startedAt: startedAt.toISOString(),
        endsAt: endsAt.toISOString(),
      })
      return { success: true, data, escrowState }
    }

    return { success: true, escrowState }
  } catch (error) {
    console.error("Error in confirmStake:", error)
    return { success: false, error: "Failed to confirm stake" }
  }
}

function normalizeSubmittedWords(foundWords: string[]): string[] {
  const unique = new Set<string>()
  for (const candidate of foundWords) {
    if (typeof candidate !== "string") continue
    const word = candidate.trim().toUpperCase()
    if (word) unique.add(word)
  }
  return Array.from(unique)
}

function scoreMatchWords(words: string[]): number {
  return words.reduce((total, word) => total + word.length, 0)
}

export async function syncLiveMatchProgress(matchId: string, userId: string, foundWords: string[]) {
  try {
    const { data: match, error: matchError } = await supabaseAdmin
      .from("matches")
      .select("id, status, board_snapshot")
      .eq("id", matchId)
      .single()

    if (matchError || !match) {
      return { success: false, error: matchError?.message ?? "Match not found" }
    }
    if (match.status !== "active") {
      return { success: false, error: "Match is not active" }
    }

    const board = (match.board_snapshot as BoardSnapshot | null)?.board
    if (!Array.isArray(board) || board.length !== 4 || board.some((row) => !Array.isArray(row) || row.length !== 4)) {
      return { success: false, error: "Match board snapshot is invalid" }
    }

    const submittedWords = normalizeSubmittedWords(foundWords)
    const dictionary = new Set(words3.map((word) => word.trim().toUpperCase()))
    const dictionaryCandidates = submittedWords.filter(
      (word) => word.length >= MIN_MATCH_WORD_LENGTH && dictionary.has(word),
    )
    const boardValidWords = findWordsOnBoard(board, dictionaryCandidates)
    const validWords = dictionaryCandidates.filter((word) => boardValidWords.has(word))
    const serverScore = scoreMatchWords(validWords)

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("match_participants")
      .update({ score: serverScore, found_words: validWords })
      .eq("match_id", matchId)
      .eq("user_id", userId)
      .select("score, found_words")
      .maybeSingle()

    if (updateError) {
      return { success: false, error: updateError.message }
    }
    if (!updated) {
      return { success: false, error: "Participant not found" }
    }

    return { success: true, data: { score: serverScore, foundWords: validWords } }
  } catch (error) {
    console.error("Error in syncLiveMatchProgress:", error)
    return { success: false, error: "Failed to sync live match progress" }
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

export async function settleMatch(matchId: string) {
  // Idempotent: settling an already-settled/refunded match is a no-op so
  // callers (submitScore, the settle API route, the reconcile sweep) can
  // all safely call this without coordinating who "owns" the transition.
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

  const escrowClient = await getEscrowClient()

  if (!winner) {
    // Tie: refund both rather than an arbitrary winner-takes-all pick.
    await escrowClient.refundTimeout(matchId)
    const { data, error } = await supabaseAdmin
      .from("matches")
      .update({ status: "refunded" })
      .eq("id", matchId)
      .select()
      .single()

    await logMatchEvent(matchId, "tie_refunded", {})
    if (!error) {
      await broadcastMatchTransition(matchId, "match_ended", { status: "refunded", winnerUserId: null })
    }
    return { success: !error, data, error: error?.message }
  }

  const { txHash } = await escrowClient.settle(matchId, winner.user_id)

  const { data, error } = await supabaseAdmin
    .from("matches")
    .update({ status: "settled", winner_user_id: winner.user_id, payout_tx_hash: txHash })
    .eq("id", matchId)
    .select()
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  await logMatchEvent(matchId, "settled", { winnerUserId: winner.user_id, txHash })
  await broadcastMatchTransition(matchId, "match_ended", {
    status: "settled",
    winnerUserId: winner.user_id,
    payoutTxHash: txHash,
  })

  return { success: true, data }
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
        const escrowClient = await getEscrowClient()
        await escrowClient.refundTimeout(matchId)
        const { data, error: updateError } = await supabaseAdmin
          .from("matches")
          .update({ status: "refunded" })
          .eq("id", matchId)
          .select()
          .single()

        await logMatchEvent(matchId, "stake_deadline_refunded", {})
        if (!updateError) {
          await broadcastMatchTransition(matchId, "match_ended", { status: "refunded", winnerUserId: null })
        }
        return { success: !updateError, data, error: updateError?.message }
      }
    }

    return { success: true, data: match, noActionNeeded: true }
  } catch (error) {
    console.error("Error in reconcileMatch:", error)
    return { success: false, error: "Failed to reconcile match" }
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
