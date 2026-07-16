# AI usage disclosure

The assignment permits AI tools and asks how they were used.

## How

I used **GitHub Copilot (agent mode, Claude)** as a pair-programmer throughout, in this
workflow:

1. **Design first, by me.** The architecture decisions — ports & adapters for platforms,
   read-through cache sync, transactional outbox for replies, keyset pagination, the unified
   comment model — were decided upfront in a written plan before any code was generated. The
   AI was directed to implement *that* plan, and I reviewed each layer as it was produced.
2. **Code generation under review.** Boilerplate-heavy layers (DTOs with Swagger decorators,
   Prisma schema wiring, test scaffolding, mock adapter fixtures) were AI-generated and then
   reviewed/adjusted. Domain-critical logic (sync parent-resolution, outbox state machine,
   idempotency race handling) was specified precisely and verified with unit tests I read
   line by line.
3. **Verification, not trust.** Every flow was exercised twice: manually with `curl` against
   the running API (pagination walk, idempotency replay, simulated platform failures) and via
   the automated suites (28 unit + 13 e2e tests).
4. **Documentation drafting.** ADRs and diagrams were drafted with AI from my decisions and
   edited for accuracy.

## What stayed human

- All trade-off decisions (and the rejected alternatives listed in each ADR).
- Assumption-making where the requirements were silent (docs/ASSUMPTIONS.md).
- Final review of every file in the repository.

## Why this workflow

It mirrors how I use AI at work: AI accelerates typing and breadth, while design intent,
correctness verification and accountability remain with the engineer. The measure of that is
this document set — I can defend any line of this codebase without the tool.
