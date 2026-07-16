/**
 * Domain errors carry an HTTP status + stable machine-readable code, so the
 * global exception filter can translate them into RFC 9457 problem responses
 * without the domain layer knowing anything about HTTP.
 */
export abstract class DomainError extends Error {
  protected constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class PostNotFoundError extends DomainError {
  constructor(postId: string) {
    super(`Post ${postId} not found`, 404, 'POST_NOT_FOUND');
  }
}

export class PostNotPublishedError extends DomainError {
  constructor(postId: string, status: string) {
    super(
      `Post ${postId} is ${status}; comments exist only for published posts`,
      409,
      'POST_NOT_PUBLISHED',
    );
  }
}

export class PlatformPostNotFoundError extends DomainError {
  constructor(postId: string, platform: string) {
    super(`Post ${postId} was not published to ${platform}`, 404, 'PLATFORM_POST_NOT_FOUND');
  }
}

export class CommentNotFoundError extends DomainError {
  constructor(commentId: string) {
    super(`Comment ${commentId} not found`, 404, 'COMMENT_NOT_FOUND');
  }
}

export class UnsupportedPlatformError extends DomainError {
  constructor(platform: string) {
    super(`Platform ${platform} is not supported`, 400, 'UNSUPPORTED_PLATFORM');
  }
}

export class ReplyDepthExceededError extends DomainError {
  constructor(platform: string, maxDepth: number) {
    super(
      `${platform} allows a maximum reply depth of ${maxDepth}`,
      422,
      'REPLY_DEPTH_EXCEEDED',
    );
  }
}

export class ReplyBodyTooLongError extends DomainError {
  constructor(platform: string, maxLength: number) {
    super(
      `${platform} limits comments to ${maxLength} characters`,
      422,
      'REPLY_BODY_TOO_LONG',
    );
  }
}

/** Cannot reply to a comment that hasn't been confirmed on the platform yet. */
export class ReplyTargetNotSyncedError extends DomainError {
  constructor(commentId: string) {
    super(
      `Comment ${commentId} has no platform identity yet (delivery pending or failed)`,
      409,
      'REPLY_TARGET_NOT_SYNCED',
    );
  }
}

export class InvalidCursorError extends DomainError {
  constructor() {
    super('The provided cursor is malformed', 400, 'INVALID_CURSOR');
  }
}

/** Same Idempotency-Key reused with different request parameters. */
export class IdempotencyKeyConflictError extends DomainError {
  constructor() {
    super(
      'This Idempotency-Key was already used with a different target comment or body',
      422,
      'IDEMPOTENCY_KEY_CONFLICT',
    );
  }
}
