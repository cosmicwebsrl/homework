import { Platform } from '@prisma/client';

/**
 * A platform comment normalized into our domain shape.
 * Each adapter maps its platform's native payload (Graph API, LinkedIn URNs,
 * IG Graph…) into this structure, so the rest of the system is platform-agnostic.
 */
export interface NormalizedPlatformComment {
  externalId: string;
  /** Platform ID of the parent comment; null for top-level comments. */
  externalParentId: string | null;
  authorExternalId: string;
  authorName: string;
  body: string;
  publishedAt: Date;
}

export interface FetchCommentsResult {
  comments: NormalizedPlatformComment[];
}

/**
 * Per-platform behavioral differences, declared as data instead of scattered
 * conditionals. The service layer enforces these before calling the platform.
 */
export interface PlatformCapabilities {
  /** Maximum threading depth the platform supports (1 = replies to top-level only). */
  maxReplyDepth: number;
  /** Maximum characters allowed in a comment/reply. */
  maxCommentLength: number;
}

export interface PostReplyInput {
  externalPostId: string;
  externalParentCommentId: string;
  body: string;
}

/**
 * Port ("hexagonal architecture") for social platform integrations.
 *
 * Supporting a new platform requires only:
 *   1. a new `Platform` enum value in the Prisma schema,
 *   2. a class implementing this interface,
 *   3. registering it in PlatformsModule.
 * No changes to the comments domain logic or the REST layer.
 */
export interface SocialPlatformAdapter {
  readonly platform: Platform;
  readonly capabilities: PlatformCapabilities;

  /** Fetch all comments (incl. replies) for a published post. */
  fetchComments(externalPostId: string): Promise<FetchCommentsResult>;

  /** Publish a reply to an existing comment; returns the platform's view of it. */
  postReply(input: PostReplyInput): Promise<NormalizedPlatformComment>;
}

/** DI token under which all adapters are collected for the registry. */
export const SOCIAL_PLATFORM_ADAPTERS = Symbol('SOCIAL_PLATFORM_ADAPTERS');
