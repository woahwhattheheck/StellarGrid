// Stable interface for staking/escrow calls used throughout the app.
// This lets the rest of the codebase (match-actions, UI) be written once
// against `getEscrowClient()` and swapped from a mock to the real Trustless
// Work SDK later without touching any call sites.
//
// Trustless Work (github.com/Trustless-Work/Trustless-Work-Smart-Escrow) is
// an existing open-source Soroban escrow contract that supports USDC and is
// already used by GrantFox itself for contributor payouts — this project
// integrates it rather than authoring a custom escrow contract. Wiring the
// real SDK behind `trustlessWorkEscrowClient.ts` is tracked as a follow-up
// contributor issue; see CONTRIBUTING.md.

export type EscrowStatus = "Created" | "Funded" | "Settled" | "Cancelled" | "Refunded" | "TimedOut"

export interface EscrowMatchState {
  matchId: string
  status: EscrowStatus
  playerADeposited: boolean
  playerBDeposited: boolean
  winner?: string
  /** Provider transaction hash when the provider exposes it during recovery. */
  txHash?: string
}

export interface CreateMatchEscrowParams {
  matchId: string
  playerA: string
  playerB: string
  stakeAmount: string
  asset: "USDC"
}

export interface EscrowClient {
  /** Registers a new match with the escrow provider. Returns a provider-side escrow reference. */
  createMatch(params: CreateMatchEscrowParams): Promise<{ escrowId: string }>

  /** Builds an unsigned transaction for the given player to sign client-side via their wallet. */
  buildDepositTx(matchId: string, player: string): Promise<{ xdr: string }>

  /** Submits a wallet-signed transaction (from buildDepositTx) to the network. */
  submitSignedTx(xdr: string): Promise<{ txHash: string }>

  /** Server-side only: releases the full pot to the winner. */
  settle(matchId: string, winner: string): Promise<{ txHash: string }>

  /** Server-side only: refunds whichever player deposited, if the stake deadline passed without both staking. */
  refundTimeout(matchId: string): Promise<{ txHash: string }>

  /** Reads current escrow state for a match. */
  getMatchState(matchId: string): Promise<EscrowMatchState>
}

export type EscrowMode = "mock" | "live"

export function getEscrowMode(): EscrowMode {
  const mode = process.env.NEXT_PUBLIC_ESCROW_MODE
  return mode === "live" ? "live" : "mock"
}

/**
 * Returns the active escrow client implementation. Only "mock" is implemented
 * in this codebase today — "live" (Trustless Work SDK) is a contributor issue
 * (see CONTRIBUTING.md / GitHub issues) and this factory will throw until
 * `trustlessWorkEscrowClient.ts` is added.
 */
export async function getEscrowClient(): Promise<EscrowClient> {
  const mode = getEscrowMode()

  if (mode === "live") {
    throw new Error(
      "NEXT_PUBLIC_ESCROW_MODE=live requires lib/soroban/trustlessWorkEscrowClient.ts, " +
        "which has not been implemented yet. See the 'Integrate Trustless Work SDK' issue.",
    )
  }

  const { mockEscrowClient } = await import("./mockEscrowClient")
  return mockEscrowClient
}
