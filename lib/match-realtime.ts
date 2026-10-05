import { supabaseAdmin } from "@/lib/supabase-admin"

export type MatchTransitionEvent =
  | "opponent_joined"
  | "stake_confirmed"
  | "match_started"
  | "match_ended"

/**
 * Broadcasts a match transition from a server action. Supabase Realtime falls
 * back to its HTTP broadcast path when this short-lived channel is not joined,
 * which keeps transition delivery independent from a long-lived server socket.
 *
 * Delivery is best-effort: database state remains authoritative and reconnecting
 * clients always hydrate it through getMatch().
 */
export async function broadcastMatchTransition(
  matchId: string,
  event: MatchTransitionEvent,
  payload: Record<string, unknown>,
) {
  const channel = supabaseAdmin.channel(`match:${matchId}`, {
    config: { broadcast: { ack: true } },
  })

  try {
    const status = await channel.send({ type: "broadcast", event, payload })
    if (status !== "ok") {
      console.warn(`Realtime broadcast ${event} for match ${matchId} returned ${status}`)
    }
  } catch (error) {
    console.error(`Realtime broadcast ${event} failed for match ${matchId}:`, error)
  } finally {
    try {
      await supabaseAdmin.removeChannel(channel)
    } catch (error) {
      console.error(`Failed to remove Realtime channel for match ${matchId}:`, error)
    }
  }
}
