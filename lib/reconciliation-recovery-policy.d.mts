export interface RecoveryClaimProof {
  action: "settle" | "refund"
  winnerUserId: string | null
}

export interface RecoveryProviderState {
  status: string
  winner?: string
}

export type RecoveryAssessment =
  | { canFinalize: true }
  | { canFinalize: false; reason: string }

export function assessRecoveredProviderOutcome(
  claim: RecoveryClaimProof,
  providerState: RecoveryProviderState,
): RecoveryAssessment
