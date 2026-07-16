# ADR-0004: Keyset (cursor) pagination

**Status:** accepted

## Context

Comment lists are append-heavy and potentially large (viral posts reach 10k+ comments).
The two standard options:

- **OFFSET/LIMIT:** trivially implementable, but (a) pages shift as new comments arrive —
  clients see duplicates or miss rows while paginating, and (b) `OFFSET n` scans and discards
  n rows, degrading linearly on deep pages.
- **Keyset ("seek"):** paginate by *position in a total order*, not by row count. Stable under
  concurrent inserts and O(page) per request via an index range scan.

## Decision

Keyset pagination over the tuple `(occurredAt, id)`:

- `occurredAt` provides chronology; `id` breaks ties, making the sort total.
- The cursor is an **opaque** base64url token (`ISO-timestamp|id`). Clients cannot construct
  or interpret it, so the encoding can change without breaking anyone.
- Next page predicate: `occurredAt > c OR (occurredAt = c AND id > c.id)`, served by the
  composite index `(platformPostId, occurredAt, id)`.
- `limit + 1` rows are fetched to compute `nextCursor` without a separate `COUNT`.

Pagination applies to **top-level comments**; replies come nested with their parent. This
matches how comment UIs consume data and keeps the cursor semantics simple. (Trade-off: a
comment with enormous reply counts would need nested reply pagination — documented in
ASSUMPTIONS as out of scope.)

## Consequences

- Stable, index-backed pages at any depth; no drift under live inserts.
- No `totalCount` / "jump to page 7" — inherent to keyset, and the right trade for feeds.
- Cursors embed a timestamp+id; if ordering requirements ever change (e.g., "top comments"),
  a new cursor variant is needed — the opaque encoding leaves room for that.
