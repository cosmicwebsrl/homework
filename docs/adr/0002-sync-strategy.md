# ADR-0002: Sync strategy — read-through cache (pull on demand, persist locally)

**Status:** accepted

## Context

Comments live on the platforms; we need to serve them from our API. Three broad strategies:

| Strategy | Freshness | Infra cost | Notes |
|---|---|---|---|
| Proxy every read to the platform | perfect | none | rate limits burn fast; no cross-platform pagination; down platform = down endpoint |
| Webhooks / streaming ingestion | near-real-time | high | the production ideal; needs public endpoints, per-platform subscription handling, replay handling |
| **Pull on demand + local persistence (chosen)** | bounded staleness (TTL) | low | one code path; degrades gracefully |

## Decision

`GET /posts/:id/comments` checks `commentsSyncedAt` per platform publication. If older than
`COMMENTS_SYNC_TTL_SECONDS` (default 60s), fetch from the adapter and **upsert** into the
local `comments` table keyed by `(platformPostId, externalCommentId)` — re-syncs are
idempotent. Platform publications are independent, so stale platforms are synced
**concurrently** (read-path latency is the slowest platform's, not the sum). The page is then
always served from PostgreSQL.

During the mirror step, external parent IDs are resolved to local rows in dependency order:
a child whose parent appears elsewhere in the payload is deferred until the parent is
persisted; only comments whose parent is absent from both the payload and the local store are
degraded to top-level (orphans). Payload ordering therefore never corrupts threading.

Degradation rules:
- Platform unreachable **and** a previous sync exists → serve the cached copy, report
  `state: STALE` in `meta.syncStatus`.
- Platform unreachable on the **first ever** sync → surface the platform error (429/502);
  there is nothing meaningful to serve.

## Why local persistence at all (vs. pure proxy)

- **Uniformity:** cursor pagination, platform filtering and threading work identically across
  platforms because they run on our data model, not on N platform paginators.
- **Resilience:** platform outages degrade to stale data instead of failures.
- **Rate-limit economy:** N user reads within the TTL cost 1 platform call.
- **It's required anyway:** locally authored replies must be persisted (outbox, ADR-0003),
  so the storage model must exist regardless.

## Consequences

- Comments can be up to TTL seconds stale — acceptable for a scheduling/moderation tool, and
  the response *says so* via `meta.syncStatus`.
- Sync happens in the read path (adds latency on cache miss). Production evolution: move sync
  to a background queue and/or platform webhooks — the adapter port and the mirror logic
  (`mirrorComments`) are reused unchanged; only the *trigger* changes. This is deliberate:
  the chosen design is the first increment of the webhook architecture, not a dead end.
- Deleted-on-platform comments are not garbage-collected yet (documented in ASSUMPTIONS).
