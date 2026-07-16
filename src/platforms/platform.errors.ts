import { Platform } from '@prisma/client';

/**
 * Errors raised by platform adapters, normalized so the domain layer can react
 * uniformly (retry vs. fail permanently) regardless of which platform threw.
 */
export abstract class PlatformApiError extends Error {
  protected constructor(
    readonly platform: Platform,
    message: string,
    /** Whether a retry (later) could plausibly succeed. Drives outbox semantics. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** HTTP 429 from the platform — retryable. */
export class PlatformRateLimitedError extends PlatformApiError {
  constructor(platform: Platform) {
    super(platform, `${platform} rate limit exceeded`, true);
  }
}

/** Platform is down / 5xx — retryable. */
export class PlatformUnavailableError extends PlatformApiError {
  constructor(platform: Platform) {
    super(platform, `${platform} is temporarily unavailable`, true);
  }
}

/** The post/comment no longer exists on the platform (deleted/moderated) — permanent. */
export class PlatformEntityNotFoundError extends PlatformApiError {
  constructor(platform: Platform, entity: string) {
    super(platform, `${entity} not found on ${platform}`, false);
  }
}

/** The platform rejected the content (policy, length…) — permanent. */
export class PlatformRejectedError extends PlatformApiError {
  constructor(platform: Platform, reason: string) {
    super(platform, `${platform} rejected the request: ${reason}`, false);
  }
}
