import { create } from "zustand"
import { deobfuscateWords } from "@/utils/wordObfuscation"
import { createMatch, joinMatch, confirmStake, submitScore, getMatch, listOpenMatches } from "@/lib/match-actions"
import { supabase } from "@/lib/supabase"

// Match-scoped Zustand store, parallel to (not merged with) stores/gameStore.ts.
// The existing daily single-player puzzle path is untouched by this store.

export type MatchStatus =
  | "created"
  | "awaiting_stakes"
  | "active"
  | "completed"
  | "settled"
  | "cancelled"
  | "refunded"
  | "disputed"

export interface OpponentState {
  userId: string
  score: number
  connectionStatus: "connected" | "disconnected"
  staked: boolean
  submitted: boolean
}

export interface OpenMatchSummary {
  id: string
  stake_amount: number
  asset_code: string
  created_by: string
  created_at: string
}

interface MatchStore {
  matchId: string | null
  currentUserId: string | null
  status: MatchStatus | null
  stakeAmount: number | null
  assetCode: string | null
  board: string[][]
  possibleWords: string[]
  totalPossibleWords: number
  foundWords: string[]
  score: number
  myStaked: boolean
  winnerUserId: string | null
  payoutTxHash: string | null
  startedAt: string | null
  endsAt: string | null
  loading: boolean
  error: string | null
  opponent: OpponentState | null
  openMatches: OpenMatchSummary[]

  createNewMatch: (userId: string, stakeAmount: number) => Promise<string | null>
  joinExistingMatch: (matchId: string, userId: string) => Promise<boolean>
  confirmMyStake: (userId: string) => Promise<void>
  loadMatch: (matchId: string, userId: string) => Promise<void>
  refreshOpenMatches: () => Promise<void>
  addFoundWord: (word: string, points: number) => void
  submitFinalScore: (userId: string) => Promise<void>
  subscribeToMatch: (matchId: string, currentUserId: string) => () => void
  reset: () => void
}

const initialState = {
  matchId: null,
  currentUserId: null as string | null,
  status: null,
  stakeAmount: null,
  assetCode: null,
  board: Array(4).fill(null).map(() => Array(4).fill("")),
  possibleWords: [] as string[],
  totalPossibleWords: 0,
  foundWords: [] as string[],
  score: 0,
  myStaked: false,
  winnerUserId: null,
  payoutTxHash: null,
  startedAt: null,
  endsAt: null,
  loading: false,
  error: null,
  opponent: null as OpponentState | null,
  openMatches: [] as OpenMatchSummary[],
}

export const useMatchStore = create<MatchStore>((set, get) => ({
  ...initialState,

  createNewMatch: async (userId, stakeAmount) => {
    set({ loading: true, error: null })
    const result = await createMatch(userId, stakeAmount)
    set({ loading: false })
    if (!result.success || !result.data) {
      set({ error: result.error ?? "Failed to create match" })
      return null
    }
    await get().loadMatch(result.data.id, userId)
    return result.data.id
  },

  joinExistingMatch: async (matchId, userId) => {
    set({ loading: true, error: null })
    const result = await joinMatch(matchId, userId)
    set({ loading: false })
    if (!result.success) {
      set({ error: result.error ?? "Failed to join match" })
      return false
    }
    await get().loadMatch(matchId, userId)
    return true
  },

  confirmMyStake: async (userId) => {
    const { matchId } = get()
    if (!matchId) return
    set({ loading: true, error: null })
    const result = await confirmStake(matchId, userId)
    set({ loading: false })
    if (!result.success) {
      set({ error: result.error ?? "Failed to confirm stake" })
      return
    }
    await get().loadMatch(matchId, userId)
  },

  loadMatch: async (matchId, currentUserId) => {
    set({ loading: true, error: null })
    const result = await getMatch(matchId)
    set({ loading: false })
    if (!result.success || !result.data) {
      set({ error: result.error ?? "Failed to load match" })
      return
    }

    const { match, participants } = result.data
    const me = participants.find((p: any) => p.user_id === currentUserId)
    const opponentRow = participants.find((p: any) => p.user_id !== currentUserId)

    const key = String(match.board_seed)
    const snapshot = match.board_snapshot
    const possibleWords = deobfuscateWords(snapshot.possibleWords, key)

    set({
      matchId: match.id,
      currentUserId,
      status: match.status,
      stakeAmount: match.stake_amount,
      assetCode: match.asset_code,
      board: snapshot.board,
      possibleWords,
      totalPossibleWords: snapshot.totalPossibleWords,
      foundWords: me?.found_words ?? [],
      score: me?.score ?? 0,
      myStaked: Boolean(me?.staked_at),
      winnerUserId: match.winner_user_id,
      payoutTxHash: match.payout_tx_hash,
      startedAt: match.started_at,
      endsAt: match.ends_at,
      opponent: opponentRow
        ? {
            userId: opponentRow.user_id,
            score: opponentRow.score,
            connectionStatus: opponentRow.connection_status,
            staked: Boolean(opponentRow.staked_at),
            submitted: Boolean(opponentRow.submitted_at),
          }
        : null,
    })
  },

  refreshOpenMatches: async () => {
    const result = await listOpenMatches()
    if (result.success && result.data) {
      set({ openMatches: result.data })
    }
  },

  addFoundWord: (word, points) => {
    const { foundWords, score, matchId, currentUserId } = get()
    if (foundWords.includes(word)) return
    const newScore = score + points
    set({ foundWords: [...foundWords, word], score: newScore })

    // Broadcast score/count only (never the found-words list) so the
    // opponent can't see which specific words were found, per the plan's
    // anti-leakage note. Best-effort — a dropped broadcast just means the
    // opponent's live view lags until the next update or match end.
    if (matchId && currentUserId) {
      supabase.channel(`match:${matchId}`).send({
        type: "broadcast",
        event: "score_update",
        payload: { userId: currentUserId, score: newScore, wordsFound: foundWords.length + 1 },
      })
    }
  },

  submitFinalScore: async (userId) => {
    const { matchId, score, foundWords } = get()
    if (!matchId) return
    set({ loading: true, error: null })

    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession()

    if (sessionError || !session?.access_token || session.user.id !== userId) {
      set({ loading: false, error: "You must be signed in as this match participant to submit a score" })
      return
    }

    const result = await submitScore(matchId, userId, session.access_token, score, foundWords)
    set({ loading: false })
    if (!result.success) {
      set({ error: result.error ?? "Failed to submit score" })
      return
    }
    await get().loadMatch(matchId, userId)
  },

  // Realtime channel: one per match, broadcasting opponent score/status updates.
  // Returns an unsubscribe function. See app/api/matches for server-side settle triggers.
  subscribeToMatch: (matchId, currentUserId) => {
    const channel = supabase
      .channel(`match:${matchId}`)
      .on("broadcast", { event: "score_update" }, ({ payload }) => {
        if (payload.userId === currentUserId) return
        set((state) => ({
          opponent: state.opponent
            ? { ...state.opponent, score: payload.score }
            : { userId: payload.userId, score: payload.score, connectionStatus: "connected", staked: true, submitted: false },
        }))
      })
      .on("broadcast", { event: "match_ended" }, () => {
        get().loadMatch(matchId, currentUserId)
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  },

  reset: () => set(initialState),
}))
