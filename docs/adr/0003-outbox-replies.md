# ADR-0003: Replies via transactional outbox + idempotency keys

**Status:** accepted

## Context

Posting a reply spans two systems that cannot share a transaction: our database and a
third-party platform API. Naive designs lose data in predictable ways:

- *Call platform first, then save:* success on platform + crash before save = reply exists
  publicly but not in our system (and a user retry duplicates it).
- *Save and call with no state machine:* a platform timeout leaves the client guessing;
  retries duplicate.

## Decision

**Persist intent first, deliver second, record the outcome** — the outbox pattern:

1. `INSERT` the reply with `source=LOCAL`, `status=PENDING` (durable user intent).
2. Attempt synchronous delivery through the platform adapter.
3. Outcome:
   - delivered → `SENT`, store the platform's `externalCommentId`;
   - **retryable** error (rate limit, outage) → stays `PENDING`; a background worker
     (roadmap) retries with backoff;
   - **permanent** rejection (policy) → `FAILED` + `failureReason`.

The API responds **202 Accepted** with a `Location` header — honest semantics: the write is
durable but platform delivery may still be pending. Clients poll `GET /comments/:id`.

**Idempotency:** clients may send an `Idempotency-Key` header, stored on the comment row with
a unique constraint. A replay returns the original reply (`Idempotency-Replayed: true`).
Concurrent duplicates are resolved by the DB constraint (the P2002 loser fetches the winner) —
correctness comes from the database, not from application-level locking.

Adapters classify errors themselves (`PlatformApiError.retryable`), because only the adapter
knows whether a given platform response is transient.

## Alternatives considered

- **Fully synchronous 201-or-500** — simplest, but conflates "we lost your reply" with
  "the platform is briefly rate-limiting"; hostile to retries.
- **Full queue from day one (BullMQ/SQS)** — the production shape, but heavy for a take-home;
  the chosen design is queue-ready: the PENDING rows *are* the queue's work items.

## Consequences

- No lost replies, no duplicated replies, and failures are inspectable (`failureReason`).
- One extra DB write per reply; a `PENDING` state clients must understand (documented in the
  API contract and Swagger).
- A stuck-PENDING sweeper/worker is required for production (roadmap item, intentionally cut).
