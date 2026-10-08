# Match reconciliation cron

Staked matches have server-side deadlines even when both clients disconnect. Vercel Cron calls `GET /api/matches/reconcile-all` every minute so those deadlines are enforced without a player request:

- `active` matches with `ends_at` in the past are passed to the existing `reconcileMatch`, which settles the match.
- `awaiting_stakes` matches with `stake_deadline_at` in the past are passed to the same reconciler, which refunds when both deposits were not confirmed.

The one-minute schedule is intentionally shorter than both lifecycle windows (two minutes for staking and three minutes for play), so a disconnected match is normally swept within about one minute of its deadline. `reconcileMatch` uses a database-owned claim/CAS before every money-moving provider call, and the existing per-match reconcile route is unchanged.

## Deployment

Set a server-only `CRON_SECRET` in the Vercel project. Vercel sends it to cron invocations as `Authorization: Bearer <CRON_SECRET>`; the bulk route returns `503` when the secret is not configured and `401` when the bearer value is wrong. Do not prefix this variable with `NEXT_PUBLIC_`.

The sweep pages through all matching rows, then reconciles matches sequentially to avoid issuing a burst of escrow operations. It continues after an individual reconciliation failure and returns a non-2xx response with the failed match IDs so the cron run is visible as failed.

## Settlement safety and recovery

The claim transition is atomic in Postgres, so only one serverless caller can own a match operation. A second caller is a no-op. Claims that never crossed the durable `attempted_at` fence can be reclaimed after five minutes; attempted claims are never automatically stolen.

If a provider call succeeds but the database finalization response is lost, the match remains claimed. The next sweep reads provider state: it finalizes only a matching `Settled` or `Refunded` result. Non-terminal, conflicting, or unreadable provider state is marked ambiguous and **is not resubmitted automatically**. An operator must establish provider-side failure before clearing such a claim, preventing a timeout or transient error from duplicating a settlement/refund.
