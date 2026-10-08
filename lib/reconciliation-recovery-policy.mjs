/**
 * Decide whether provider state proves the exact terminal outcome stored in a
 * durable reconciliation claim. This function is intentionally pure so its
 * money-movement recovery rules can be tested without a provider or database.
 *
 * @param {{ action: "settle" | "refund", winnerUserId: string | null }} claim
 * @param {{ status: string, winner?: string }} providerState
 * @returns {{ canFinalize: true } | { canFinalize: false, reason: string }}
 */
export function assessRecoveredProviderOutcome(claim, providerState) {
  const expectedStatus = claim.action === "settle" ? "Settled" : "Refunded"

  if (providerState.status !== expectedStatus) {
    return {
      canFinalize: false,
      reason: `Provider reports ${providerState.status}; expected ${expectedStatus}. Automatic retry suppressed.`,
    }
  }

  if (claim.action === "settle" && providerState.winner !== claim.winnerUserId) {
    return {
      canFinalize: false,
      reason: "Provider winner is missing or conflicts with the durable claim. Automatic retry suppressed.",
    }
  }

  return { canFinalize: true }
}
