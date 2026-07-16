# Social Scheduler — Comment System

A comment system for a **social media scheduling API** that publishes posts to multiple
platforms (Facebook, LinkedIn, Instagram) and is expected to support more in the future.

Every major choice is documented in
[docs/adr](docs/adr).

## What it does

| Capability | Endpoint |
|---|---|
| Retrieve comments for a published post (all platforms or one) | `GET /api/v1/posts/:postId/comments` |
| Reply to a comment | `POST /api/v1/comments/:commentId/replies` |
| Poll a reply's delivery status | `GET /api/v1/comments/:commentId` |

Interactive API docs (Swagger UI): **http://localhost:3000/docs**

## Architecture in one paragraph

Platform integrations sit behind a single **port interface** (`SocialPlatformAdapter`) with one
adapter per platform — adding a platform touches zero domain code. Comments are read through a
**read-through cache**: stale platforms are re-fetched on demand (concurrently) and mirrored
into PostgreSQL, so pagination/filtering/threading behave identically across platforms and the
API degrades gracefully when a platform is down. Replies use a **transactional outbox**: the
reply is persisted as `PENDING` before the platform call and promoted to `SENT`/`FAILED` after,
with `Idempotency-Key` support so client retries never duplicate (reusing a key with different
parameters is rejected with `422 IDEMPOTENCY_KEY_CONFLICT`).

## Tech stack

- **NestJS 11** (TypeScript, strict mode) — modular DI, first-class Swagger & validation
- **PostgreSQL + Prisma 6** — schema in [prisma/schema.prisma](prisma/schema.prisma)
- **Jest + Supertest** — 30 unit tests, 14 e2e tests

## Quickstart

Prerequisites: Node ≥ 20 and PostgreSQL running on `localhost:5432`
(either a local install or `docker compose up -d`).

```bash
npm install
cp .env.example .env          # adjust DATABASE_URL if needed
npx prisma migrate dev        # create schema (or: npm run prisma:push)
npm run seed                  # posts + platform publications (comments come from sync)
npm run start:dev             # http://localhost:3000/docs
```

### Try it

```bash
# Comments for a post published to FB + LinkedIn + Instagram (first call syncs from platforms)
curl 'http://localhost:3000/api/v1/posts/post_published_1/comments?limit=5'

# Reply to a comment (grab an id from the previous response)
curl -X POST 'http://localhost:3000/api/v1/comments/<commentId>/replies' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-key-1' \
  -d '{"body": "Thanks for asking — yes, we ship worldwide!"}'

# Poll delivery status (Location header of the reply response)
curl 'http://localhost:3000/api/v1/comments/<replyId>'
```

The mock platforms simulate failures deterministically — include a magic string in the reply body:

| Magic string | Simulates | Outcome |
|---|---|---|
| `[simulate:rate-limit]` | HTTP 429 from the platform | reply stays `PENDING` (retryable) |
| `[simulate:downtime]` | platform outage | reply stays `PENDING` (retryable) |
| `[simulate:rejected]` | content policy rejection | reply becomes `FAILED` (permanent) |

### Tests

```bash
npm test          # unit (service logic, adapters, cursor codec)
npm run test:e2e  # full HTTP -> DB flows against social_scheduler_test
```

## Documentation map

| Document | Contents |
|---|---|
| [docs/adr/](docs/adr) | 5 decision records: adapter pattern, sync strategy, outbox replies, cursor pagination, data model |
| [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | Every assumption made where the requirements were unspecified |
| [docs/API.md](docs/API.md) | REST API reference with examples |
| [docs/AI_USAGE.md](docs/AI_USAGE.md) | How AI tools were used (as requested by the assignment) |

## Project layout

```
src/
  platforms/                    # the extensibility seam
    platform-adapter.interface.ts   # the port: SocialPlatformAdapter
    platform-adapter.registry.ts    # resolves adapter by Platform enum
    adapters/                       # one adapter per platform (mocked integrations)
  comments/                     # the feature
    comments.controller.ts          # REST surface (versioned, validated, Swagger-annotated)
    comments.service.ts             # domain logic: sync-on-read, outbox replies, capabilities
    comments.repository.ts          # thin Prisma data access
    dto/                            # request/response contracts
  common/                       # cross-cutting: domain errors, problem-details filter, cursor codec
  prisma/                       # PrismaService (connection lifecycle)
prisma/                         # schema, migrations, seed
test/                           # e2e suite + test DB setup
docs/                           # architecture, ADRs, assumptions, interview prep
```
