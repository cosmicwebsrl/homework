# API Reference

Base URL: `http://localhost:3000/api/v1` — interactive version at `/docs` (Swagger UI).

Errors follow **RFC 9457 problem details**:

```json
{
  "type": "https://api.example.com/problems/reply_depth_exceeded",
  "title": "REPLY_DEPTH_EXCEEDED",
  "status": 422,
  "detail": "INSTAGRAM allows a maximum reply depth of 1"
}
```

`title` is a stable machine-readable code; `detail` is human-readable and may change.

---

## GET /posts/:postId/comments

Retrieve comments for a published post, aggregated across every platform it was published to.

| Query param | Type | Default | Description |
|---|---|---|---|
| `platform` | `FACEBOOK \| LINKEDIN \| INSTAGRAM` | all | restrict to one platform |
| `limit` | 1–100 | 20 | page size (top-level comments) |
| `cursor` | opaque string | — | `meta.nextCursor` from the previous page |
| `includeReplies` | boolean | `true` | nest replies under each top-level comment |

**200**

```json
{
  "data": [
    {
      "id": "cmrn…",
      "platform": "FACEBOOK",
      "platformPostId": "pp_fb_1",
      "externalCommentId": "fb_comment_502",
      "parentCommentId": null,
      "depth": 0,
      "author": { "externalId": "fb_user_12", "name": "Bogdan Ionescu" },
      "body": "Does it ship to Europe?",
      "source": "PLATFORM",
      "status": "SYNCED",
      "failureReason": null,
      "occurredAt": "2026-07-10T11:02:00.000Z",
      "publishedAt": "2026-07-10T11:02:00.000Z",
      "replies": [ { "…": "nested CommentResponse, depth 1" } ]
    }
  ],
  "meta": {
    "nextCursor": "MjAyNi0wNy0xMFQxMTowMj…",
    "syncStatus": [
      { "platform": "FACEBOOK", "state": "FRESH", "syncedAt": "2026-07-16T15:51:00.000Z" },
      { "platform": "LINKEDIN", "state": "CACHED", "syncedAt": "2026-07-16T15:50:30.000Z" },
      { "platform": "INSTAGRAM", "state": "STALE", "syncedAt": "2026-07-16T15:40:00.000Z" }
    ]
  }
}
```

`syncStatus.state`: `FRESH` = fetched on this request · `CACHED` = within TTL ·
`STALE` = platform unreachable, serving last-known data.

**Errors:** `404 POST_NOT_FOUND` · `404 PLATFORM_POST_NOT_FOUND` (not published to that
platform) · `409 POST_NOT_PUBLISHED` · `400 INVALID_CURSOR` · `429/502 PLATFORM_*_ERROR`
(first-ever sync failed).

---

## POST /comments/:commentId/replies

Reply to a comment. **Outbox semantics:** the reply is persisted immediately, delivery to the
platform is attempted synchronously, and the response reports the current delivery state.

| Header | Required | Description |
|---|---|---|
| `Idempotency-Key` | no | replaying the same key returns the original reply (`Idempotency-Replayed: true`) |

Body: `{ "body": "string" }` — non-empty; per-platform length limits enforced
(FB 8000 / LinkedIn 3000 / Instagram 2200).

**202 Accepted** + `Location: /api/v1/comments/{replyId}`

```json
{
  "id": "cmrn…",
  "platform": "FACEBOOK",
  "parentCommentId": "cmrn…",
  "depth": 1,
  "author": { "externalId": null, "name": "Scheduler User" },
  "body": "Yes, we ship EU-wide!",
  "source": "LOCAL",
  "status": "SENT",
  "externalCommentId": "fb_comment_1784217122049_1",
  "failureReason": null
}
```

`status` outcomes: `SENT` (delivered) · `PENDING` (platform temporarily unavailable — will be
retried; poll the `Location` URL) · `FAILED` (permanent rejection; see `failureReason`).

**Errors:** `404 COMMENT_NOT_FOUND` · `409 REPLY_TARGET_NOT_SYNCED` (parent has no platform
identity yet) · `422 REPLY_DEPTH_EXCEEDED` · `422 REPLY_BODY_TOO_LONG` ·
`422 IDEMPOTENCY_KEY_CONFLICT` (key reused with a different target/body) · `400` validation.

---

## GET /comments/:commentId

Fetch one comment — primarily to poll a reply's delivery status (`PENDING → SENT/FAILED`).

**200** — a `CommentResponse` (as above). **404 COMMENT_NOT_FOUND.**

---

## Design notes

- **Why 202 for replies:** honest about the two-system write — see
  [adr/0003](adr/0003-outbox-replies.md).
- **Why cursors, not page numbers:** stability under live inserts — see
  [adr/0004](adr/0004-cursor-pagination.md).
- **Resource-oriented routes:** `POST /comments/:id/replies` (creating a resource in the
  replies collection) rather than an RPC-ish `/reply`; versioned under `/api/v1` from day one.
