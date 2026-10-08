import assert from "node:assert/strict"
import test from "node:test"

import { assessRecoveredProviderOutcome } from "./reconciliation-recovery-policy.mjs"

const settlementClaim = { action: "settle", winnerUserId: "winner-a" }

test("recovered settlement requires exact provider winner proof", () => {
  assert.deepEqual(
    assessRecoveredProviderOutcome(settlementClaim, { status: "Settled", winner: "winner-a" }),
    { canFinalize: true },
  )

  for (const providerState of [
    { status: "Settled" },
    { status: "Settled", winner: "winner-b" },
  ]) {
    const assessment = assessRecoveredProviderOutcome(settlementClaim, providerState)
    assert.equal(assessment.canFinalize, false)
    assert.match(assessment.reason, /winner is missing or conflicts/)
  }
})

test("nonterminal state cannot finalize and refund recovery needs the exact terminal status", () => {
  assert.equal(
    assessRecoveredProviderOutcome(settlementClaim, { status: "Funded", winner: "winner-a" }).canFinalize,
    false,
  )
  assert.deepEqual(
    assessRecoveredProviderOutcome(
      { action: "refund", winnerUserId: null },
      { status: "Refunded" },
    ),
    { canFinalize: true },
  )
})
