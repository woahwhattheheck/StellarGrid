import { reconcileMatch } from "@/lib/match-actions"
import { supabaseAdmin } from "@/lib/supabase-admin"

const PAGE_SIZE = 1000

type MatchStatus = "active" | "awaiting_stakes"
type DeadlineColumn = "ends_at" | "stake_deadline_at"

async function listExpiredMatchIds(status: MatchStatus, deadlineColumn: DeadlineColumn, cutoff: string) {
  const ids: string[] = []

  let lastId: string | null = null

  for (;;) {
    let query = supabaseAdmin
      .from("matches")
      .select("id")
      .eq("status", status)
      .lt(deadlineColumn, cutoff)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE)

    if (lastId !== null) {
      query = query.gt("id", lastId)
    }

    const { data, error } = await query

    if (error) {
      throw new Error(`Failed to list expired ${status} matches: ${error.message}`)
    }

    const page = data ?? []
    ids.push(...page.map((match) => match.id as string))
    if (page.length < PAGE_SIZE) return ids

    lastId = page[page.length - 1].id as string
  }
}

/**
 * Reconcile every match whose server-side deadline has passed.
 *
 * Candidate discovery is paginated so the scheduled sweep does not silently
 * stop at Supabase's row-return limit. Each match is reconciled sequentially:
 * escrow operations stay bounded, while one failed match does not prevent the
 * rest of the sweep from progressing. A later run can finalize a provider
 * operation from provider state, while ambiguous operations stay durably held
 * and are never blindly resubmitted.
 */
export async function reconcileStuckMatches(now = new Date()) {
  try {
    const cutoff = now.toISOString()
    const [expiredActive, expiredStakes] = await Promise.all([
      listExpiredMatchIds("active", "ends_at", cutoff),
      listExpiredMatchIds("awaiting_stakes", "stake_deadline_at", cutoff),
    ])

    const matchIds = [...new Set([...expiredActive, ...expiredStakes])]
    const failures: Array<{ matchId: string; error: string }> = []

    for (const matchId of matchIds) {
      const result = await reconcileMatch(matchId)
      if (!result.success) {
        const error = "error" in result && typeof result.error === "string"
          ? result.error
          : "Unknown reconciliation failure"
        failures.push({ matchId, error })
      }
    }

    return {
      success: failures.length === 0,
      scanned: matchIds.length,
      processed: matchIds.length - failures.length,
      failed: failures.length,
      failures,
    }
  } catch (error) {
    console.error("Error in reconcileStuckMatches:", error)
    return {
      success: false,
      scanned: 0,
      processed: 0,
      failed: 0,
      failures: [],
      error: error instanceof Error ? error.message : "Failed to reconcile stuck matches",
    }
  }
}
