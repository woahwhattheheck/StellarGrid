import type { EscrowClient, EscrowMatchState, CreateMatchEscrowParams } from "./escrowClient"

// In-memory mock of the Trustless Work escrow flow: every call resolves
// instantly with a fake tx hash, no real Stellar network calls are made.
// This exists so the full match lifecycle (data model, server actions, UI)
// can be built and tested end-to-end before a contributor wires up the real
// Trustless Work SDK (see the "Integrate Trustless Work SDK" issue).
//
// Known limitation: this state lives in the Node process memory, so it does
// not survive a server restart / is not shared across serverless instances.
// That's fine for local dev and for the mock's purpose (unblocking Phase 1
// work); a real deployment must run in NEXT_PUBLIC_ESCROW_MODE=live once the
// Trustless Work client exists.

interface MockMatch {
  matchId: string
  playerA: string
  playerB: string
  playerADeposited: boolean
  playerBDeposited: boolean
  status: EscrowMatchState["status"]
  winner?: string
  txHash?: string
}

const matches = new Map<string, MockMatch>()

function fakeTxHash(): string {
  return `mock_tx_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export const mockEscrowClient: EscrowClient = {
  async createMatch(params: CreateMatchEscrowParams) {
    matches.set(params.matchId, {
      matchId: params.matchId,
      playerA: params.playerA,
      playerB: params.playerB,
      playerADeposited: false,
      playerBDeposited: false,
      status: "Created",
    })
    return { escrowId: `mock_escrow_${params.matchId}` }
  },

  async buildDepositTx(matchId: string, player: string) {
    // No real transaction is built in mock mode; the "xdr" just encodes
    // (matchId, player) so submitSignedTx below knows who is depositing.
    return { xdr: `mock_xdr_${matchId}__${player}` }
  },

  async submitSignedTx(xdr: string) {
    const [, rest] = xdr.split("mock_xdr_")
    const [matchId, player] = rest.split("__")
    const match = matches.get(matchId)
    if (!match) {
      throw new Error(`mockEscrowClient: unknown match ${matchId}`)
    }

    if (player === match.playerA) {
      match.playerADeposited = true
    } else if (player === match.playerB) {
      match.playerBDeposited = true
    }

    if (match.playerADeposited && match.playerBDeposited) {
      match.status = "Funded"
    }

    return { txHash: fakeTxHash() }
  },

  async settle(matchId: string, winner: string) {
    const match = matches.get(matchId)
    if (!match) {
      throw new Error(`mockEscrowClient: unknown match ${matchId}`)
    }
    const txHash = fakeTxHash()
    match.status = "Settled"
    match.winner = winner
    match.txHash = txHash
    return { txHash }
  },

  async refundTimeout(matchId: string) {
    const match = matches.get(matchId)
    if (!match) {
      throw new Error(`mockEscrowClient: unknown match ${matchId}`)
    }
    const txHash = fakeTxHash()
    match.status = "Refunded"
    match.txHash = txHash
    return { txHash }
  },

  async getMatchState(matchId: string): Promise<EscrowMatchState> {
    const match = matches.get(matchId)
    if (!match) {
      return { matchId, status: "Created", playerADeposited: false, playerBDeposited: false }
    }
    return {
      matchId,
      status: match.status,
      playerADeposited: match.playerADeposited,
      playerBDeposited: match.playerBDeposited,
      winner: match.winner,
      txHash: match.txHash,
    }
  },
}
