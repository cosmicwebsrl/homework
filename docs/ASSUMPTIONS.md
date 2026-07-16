# Assumptions

The assignment intentionally leaves details unspecified. Every gap was filled with an explicit
assumption, listed here with its rationale.

## Scope & context

1. **The surrounding scheduler exists.** `Post` and `PlatformPost` are minimal stand-ins for
   entities the real system already owns (publishing flow, external post IDs). I modeled just
   enough of them for the comment system to be coherent.
2. **Platform integrations are mocked.** No real OAuth or HTTP calls — each adapter serves
   in-memory fixtures shaped like the real platform payloads (Graph API objects, LinkedIn
   URNs, Instagram nested replies) and simulates latency plus deterministic failure modes.
   The mapping code inside each adapter is exactly what a real integration would contain;
   only the transport is fake.
3. **Authentication/authorization is out of scope** but designed for: replies record an
   author placeholder where the authenticated user would go. A real system would scope
   every query by workspace/tenant.
4. **Single writer identity per reply.** Replies are posted "as the brand/page" (how
   scheduling tools like Buffer/Hootsuite behave), not as arbitrary end-users.

## Functional behavior

5. **"Retrieve comments for a published post"** — interpreted as: aggregated across all
   platforms the post was published to, with an optional `?platform=` filter. Draft/scheduled
   posts return `409 POST_NOT_PUBLISHED` (comments cannot exist yet).
6. **Freshness:** comments may be up to `COMMENTS_SYNC_TTL_SECONDS` (60s) stale, and the
   response discloses per-platform freshness via `meta.syncStatus`. Rationale in ADR-0002.
7. **Threading:** the schema supports arbitrary depth; *policy* is per-platform via adapter
   capabilities (Instagram 1 level, Facebook 2, LinkedIn 3). Violations return
   `422 REPLY_DEPTH_EXCEEDED` *before* calling the platform.
8. **Pagination is over top-level comments** with replies nested inline. Nested pagination of
   huge reply threads is out of scope (would add a `GET /comments/:id/replies` page).
9. **Comment edits on the platform** are picked up by re-sync (upsert refreshes `body`,
   `authorName`). **Deletions on the platform** are not garbage-collected — a production
   version would reconcile via webhooks or full-page diffs.
10. **Replying to an undelivered comment** (a reply still `PENDING`/`FAILED`) is rejected
    with `409 REPLY_TARGET_NOT_SYNCED` — the platform has no ID to attach the reply to.

## Operational

11. **Retryable delivery failures stay `PENDING`** and would be drained by a background
    worker with exponential backoff — deliberately cut from the take-home (the outbox rows
    are already the work queue; see roadmap).
12. **Rate limiting our own API**, request authn, and multi-instance concerns (distributed
    locks around sync) are out of scope for this exercise.
13. **Comment volume** assumed moderate per post (≤ low tens of thousands); the keyset index
    handles this comfortably. Truly viral posts would need incremental/partial sync using
    platform-side pagination cursors instead of full-list fetches.
