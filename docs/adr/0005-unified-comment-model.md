# ADR-0005: Unified comment model (one table, three-level hierarchy)

**Status:** accepted

## Context

The data model must represent: scheduler posts, their per-platform publications, platform
comments, and our own replies — across platforms with incompatible native ID schemes and
threading rules.

## Decision

### `Post → PlatformPost → Comment` (three levels, not two)

A post published to 3 platforms is **3 independent publications**, each with its own external
ID, publish time, comment stream and sync state. Modeling `PlatformPost` explicitly (rather
than columns/JSON on `Post`) gives each publication its own `externalPostId`,
`commentsSyncedAt`, and comment FK — and makes "post published to N platforms" a row count,
not a schema change.

### One `Comment` table for synced comments *and* local replies

Discriminated by `source` (`PLATFORM` | `LOCAL`) and `status`
(`SYNCED` | `PENDING` | `SENT` | `FAILED`). Rationale: **a delivered reply *is* a platform
comment** — after `SENT` it has an `externalCommentId` and will be matched by future syncs
(the upsert hits the same unique key instead of duplicating it). Separate
`replies_outbox`-style tables force either a row migration on delivery or a `UNION` on every
read.

### Key constraints & columns

| Element | Purpose |
|---|---|
| `@@unique(platformPostId, externalCommentId)` | idempotent sync (upsert target); NULLs allowed while a local reply is undelivered |
| `parentCommentId` self-FK | arbitrary-depth threading; per-platform depth *policy* enforced via adapter capabilities, not schema |
| `depth` (denormalized) | O(1) depth checks — no recursive CTE on the write path |
| `occurredAt` | single chronological axis: platform publish time for synced comments, creation time for local replies; feeds the keyset index |
| `idempotencyKey` unique | retry-safety enforced by the database |
| String enums (`Platform`, `CommentStatus`, …) as Postgres enums | type safety end-to-end (Prisma generates the TS types) |

### IDs

Internal `cuid` primary keys, platform IDs stored verbatim in `external*` columns. Internal
and external identity are decoupled: external IDs vary wildly in format (numeric, URN,
composite) and can be absent (undelivered replies).

## Alternatives considered

- **No local comment storage (pure proxy)** — rejected in ADR-0002; also impossible for the
  outbox (ADR-0003), which *requires* local rows.
- **Per-platform comment tables** — mirrors platform schemas nicely but kills cross-platform
  queries (the primary read is "all comments for my post"), and every new platform becomes a
  DDL change.
- **JSONB payload column with a thin index layer** — flexible, but pushes shape validation to
  runtime and complicates constraints (uniqueness, FKs) that the design leans on.

## Consequences

- Cross-platform reads are one indexed query; sync and outbox share machinery.
- Author identity is denormalized (`authorExternalId`, `authorName` on each comment) — no
  `authors` table. Platforms don't give us stable cross-post author identity for free, and
  no requirement needs it; introducing it later is an additive migration.
- `depth` must be maintained by application code (set once at insert; comments never move).
