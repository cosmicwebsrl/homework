# ADR-0001: Ports & adapters for platform integrations

**Status:** accepted

## Context

The scheduler supports Facebook, LinkedIn and Instagram today and "is expected to support
more in the future". Each platform has a different API shape (Graph API objects vs. LinkedIn
URNs vs. Instagram's nested replies), different threading rules, different length limits, and
different failure modes. The comment domain logic must not accumulate `if (platform === …)`
branches.

## Decision

Define a single port interface, `SocialPlatformAdapter`, with exactly the operations the
domain needs (`fetchComments`, `postReply`) plus declarative `capabilities`
(max reply depth, max comment length). One adapter class per platform implements the port and
maps the platform's native payloads into one `NormalizedPlatformComment` shape.
A `PlatformAdapterRegistry` resolves adapters by `Platform` enum via DI; adapters
self-describe their platform, so registration is a one-line addition in `PlatformsModule`.

Adding platform N+1 requires:
1. a `Platform` enum value (schema),
2. a class implementing the port,
3. one line in the module's adapter list.

No service, controller, repository, or DTO changes.

## Alternatives considered

- **Conditionals in the service** — fastest to write, decays immediately; every platform quirk
  leaks into domain logic and tests explode combinatorially.
- **One microservice per platform** — real isolation, but wildly out of proportion for the
  problem size; adds network hops, deployment and observability overhead.
- **Generic "connector config" (data-driven, no code per platform)** — appealing until a
  platform deviates structurally (Instagram's nested replies); code is the right level of
  expressiveness for integration variance.

## Consequences

- Domain layer is platform-agnostic and unit-testable with one fake adapter.
- Platform quirks are contained in one file each and testable in isolation.
- Capabilities-as-data means the service enforces platform rules without knowing platforms.
- Cost: one small indirection layer; trivially justified by the extension requirement.
