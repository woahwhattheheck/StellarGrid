import { create } from "zustand"
import { deobfuscateWords } from "@/utils/wordObfuscation"
import {
  createMatch,
  joinMatch,
  confirmStake,
  submitScore,
  getMatch,
  listOpenMatches,
  syncLiveMatchProgress,
} from "@/lib/match-actions"
import { supabase } from "@/lib/supabase"
import type { RealtimeChannel } from "@supabase/supabase-js"

// Match-scoped Zustand store, parallel to (not merged with) stores/gameStore.ts.
// The existing daily single-player puzzle path is untouched by this store.

let activeMatchChannel: RealtimeChannel | null = null
let activeMatchChannelId: string | null = null
let progressSyncChain: Promise<void> = Promise.resolve()

function persistLiveMatchProgress(matchId: string, userId: string, foundWords: string[]) {
  progressSyncChain = progressSyncChain
    .then(async () => {
      const result = await syncLiveMatchProgress(matchId, userId, foundWords)
      if (!result.success) {
        throw new Error(result.error ?? "Failed to sync live match progress")
      }
    })
    .catch((error) => {
      console.error("Failed to persist live match progress:", error)
    })
}

async function persistConnectionStatus(
  matchId: string,
  userId: string,
  connectionStatus: "connected" | "disconnected",
) {
  const { error } = await supabase
    .from("match_participants")
    .update({ connection_status: connectionStatus })
    .eq("match_id", matchId)
    .eq("user_id", userId)

  if (error) {
    console.error(`Failed to persist ${connectionStatus} match presence:`, error)
  }
}

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

    const newFoundWords = [...foundWords, word]
    const newScore = score + points
    set({ foundWords: newFoundWords, score: newScore })

    if (matchId && currentUserId) {
      // Keep the latest word list durable while the match is active so a
      // browser disconnect does not erase the last progress the server saw.
      // The server revalidates the words and writes score/found_words itself.
      // Writes are serialized to prevent an older request winning a race.
      persistLiveMatchProgress(matchId, currentUserId, newFoundWords)

      // Opponents receive score/count only; the word list remains off the
      // broadcast channel.
      const channel =
        activeMatchChannelId === matchId && activeMatchChannel
          ? activeMatchChannel
          : supabase.channel(`match:${matchId}`)
      void channel.send({
        type: "broadcast",
        event: "score_update",
        payload: { userId: currentUserId, score: newScore, wordsFound: newFoundWords.length },
      })
    }
  },

  submitFinalScore: async (userId) => {
    const { matchId, score, foundWords } = get()
    if (!matchId) return
    set({ loading: true, error: null })
    const result = await submitScore(matchId, userId, score, foundWords)
    set({ loading: false })
    if (!result.success) {
      set({ error: result.error ?? "Failed to submit score" })
      return
    }
    await get().loadMatch(matchId, userId)
  },

  // One Realtime channel per match: score broadcasts, lifecycle transitions,
  // and Supabase Presence replace the former 3-second status polling loop.
  subscribeToMatch: (matchId, currentUserId) => {
    const channel = supabase
      .channel(`match:${matchId}`, {
        config: { presence: { key: currentUserId } },
      })
      .on("presence", { event: "sync" }, () => {
        const presentUsers = new Set(Object.keys(channel.presenceState()))
        set((state) => ({
          opponent: state.opponent
            ? {
                ...state.opponent,
                connectionStatus: presentUsers.has(state.opponent.userId) ? "connected" : "disconnected",
              }
            : null,
        }))
      })
      .on("broadcast", { event: "score_update" }, ({ payload }) => {
        if (payload.userId === currentUserId) return
        set((state) => ({
          opponent: state.opponent
            ? { ...state.opponent, score: payload.score, connectionStatus: "connected" }
            : {
                userId: payload.userId,
                score: payload.score,
                connectionStatus: "connected",
                staked: true,
                submitted: false,
              },
        }))
      })
      .on("broadcast", { event: "opponent_joined" }, () => {
        void get().loadMatch(matchId, currentUserId)
      })
      .on("broadcast", { event: "stake_confirmed" }, () => {
        void get().loadMatch(matchId, currentUserId)
      })
      .on("broadcast", { event: "match_started" }, ({ payload }) => {
        set((state) => ({
          status: "active",
          startedAt: payload.startedAt,
          endsAt: payload.endsAt,
          myStaked: true,
          opponent: state.opponent ? { ...state.opponent, staked: true } : state.opponent,
        }))
      })
      .on("broadcast", { event: "match_ended" }, () => {
        void get().loadMatch(matchId, currentUserId)
      })

    activeMatchChannel = channel
    activeMatchChannelId = matchId

    channel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return
      void get().loadMatch(matchId, currentUserId)
      void channel.track({ userId: currentUserId, connectedAt: new Date().toISOString() })
      void persistConnectionStatus(matchId, currentUserId, "connected")
    })

    return () => {
      if (activeMatchChannel === channel) {
        activeMatchChannel = null
        activeMatchChannelId = null
      }
      void persistConnectionStatus(matchId, currentUserId, "disconnected")
      void channel.untrack()
      void supabase.removeChannel(channel)
    }
  },

  reset: () => set(initialState),
}))
