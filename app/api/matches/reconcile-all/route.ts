import { type NextRequest, NextResponse } from "next/server"
import { reconcileStuckMatches } from "@/lib/reconcile-stuck-matches"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json(
      { success: false, error: "CRON_SECRET is not configured" },
      { status: 503 },
    )
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
  }

  const result = await reconcileStuckMatches()
  return NextResponse.json(result, {
    status: result.success ? 200 : 500,
    headers: { "Cache-Control": "no-store" },
  })
}
