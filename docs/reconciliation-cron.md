# Match reconciliation cron

Staked matches have server-side deadlines even when both clients disconnect. Vercel Cron calls `GET /api/matches/reconcile-all` every minute so those deadlines are enforced without a player request:

- `active` matches with `ends_at` in the past are passed to the existing `reconcileMatch`, which settles the match.
- `awaiting_stakes` matches with `stake_deadline_at` in the past are passed to the same reconciler, which refunds when both deposits were not confirmed.

The one-minute schedule is intentionally shorter than both lifecycle windows (two minutes for staking and three minutes for play), so a disconnected match is normally swept within about one minute of its deadline. `reconcileMatch` remains idempotent, and the existing per-match reconcile route is unchanged.

## Deployment

Set a server-only `CRON_SECRET` in the Vercel project. Vercel sends it to cron invocations as `Authorization: Bearer <CRON_SECRET>`; the bulk route returns `503` when the secret is not configured and `401` when the bearer value is wrong. Do not prefix this variable with `NEXT_PUBLIC_`.

The sweep pages through all matching rows, then reconciles matches sequentially to avoid issuing a burst of escrow operations. It continues after an individual reconciliation failure and returns a non-2xx response with the failed match IDs so the cron run is visible as failed; unchanged matches remain eligible for the next run.
