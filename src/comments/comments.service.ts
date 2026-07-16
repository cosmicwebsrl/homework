import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommentStatus, Platform, PlatformPost, PostStatus, Prisma } from '@prisma/client';
import { CommentsRepository } from './comments.repository';
import { PlatformAdapterRegistry } from '../platforms/platform-adapter.registry';
import { NormalizedPlatformComment } from '../platforms/platform-adapter.interface';
import { PlatformApiError } from '../platforms/platform.errors';
import {
  CommentNotFoundError,
  PlatformPostNotFoundError,
  PostNotFoundError,
  PostNotPublishedError,
  ReplyBodyTooLongError,
  ReplyDepthExceededError,
  ReplyTargetNotSyncedError,
} from '../common/errors/domain.errors';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor';
import {
  CommentResponseDto,
  CommentsPageResponseDto,
  SyncStatusDto,
} from './dto/comment.response.dto';
import { ListCommentsQueryDto } from './dto/list-comments.query.dto';
import { CreateReplyDto } from './dto/create-reply.dto';

export interface ReplyResult {
  reply: CommentResponseDto;
  /** True when an Idempotency-Key replay returned the previously created reply. */
  replayed: boolean;
}

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);
  private readonly syncTtlMs: number;

  constructor(
    private readonly repository: CommentsRepository,
    private readonly registry: PlatformAdapterRegistry,
    config: ConfigService,
  ) {
    this.syncTtlMs = config.get<number>('COMMENTS_SYNC_TTL_SECONDS', 60) * 1000;
  }

  /**
   * Read path: read-through cache.
   * 1. Validate the post exists and is published.
   * 2. For each platform publication whose cache is stale, pull comments from
   *    the platform and mirror them locally (idempotent upserts).
   * 3. Serve a keyset-paginated page from the local store — so pagination,
   *    filtering and threading behave identically across platforms.
   *
   * If a platform is unreachable but we have previously synced data, we serve
   * the stale copy and say so in meta.syncStatus (graceful degradation).
   */
  async getCommentsForPost(
    postId: string,
    query: ListCommentsQueryDto,
  ): Promise<CommentsPageResponseDto> {
    const post = await this.repository.findPostById(postId);
    if (!post) {
      throw new PostNotFoundError(postId);
    }
    if (post.status !== PostStatus.PUBLISHED) {
      throw new PostNotPublishedError(postId, post.status);
    }

    const platformPosts = await this.repository.findPlatformPosts(postId, query.platform);
    if (platformPosts.length === 0) {
      throw new PlatformPostNotFoundError(postId, query.platform ?? 'any platform');
    }

    const syncStatus: SyncStatusDto[] = [];
    for (const platformPost of platformPosts) {
      syncStatus.push(await this.syncIfStale(platformPost));
    }

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const limit = query.limit ?? 20;
    const rows = await this.repository.findTopLevelPage({
      platformPostIds: platformPosts.map((p) => p.id),
      cursor,
      limit,
      includeReplies: query.includeReplies ?? true,
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    const platformByPostId = new Map(platformPosts.map((p) => [p.id, p.platform]));
    return {
      data: page.map((c) =>
        CommentResponseDto.from(c, platformByPostId.get(c.platformPostId) as Platform),
      ),
      meta: {
        nextCursor: hasNextPage ? encodeCursor({ occurredAt: last.occurredAt, id: last.id }) : null,
        syncStatus,
      },
    };
  }

  /**
   * Write path: transactional outbox (§docs/adr/0003).
   * The reply is persisted locally as PENDING *before* the platform call, so a
   * crash or platform outage never loses user intent. The platform call then
   * promotes it to SENT, or to FAILED on a permanent rejection; retryable
   * errors keep it PENDING (a background worker would retry — see roadmap).
   */
  async replyToComment(
    commentId: string,
    dto: CreateReplyDto,
    idempotencyKey?: string,
  ): Promise<ReplyResult> {
    if (idempotencyKey) {
      const existing = await this.repository.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return {
          reply: CommentResponseDto.from(existing, existing.platformPost.platform),
          replayed: true,
        };
      }
    }

    const parent = await this.repository.findCommentById(commentId);
    if (!parent) {
      throw new CommentNotFoundError(commentId);
    }
    // A reply must target a comment that exists on the platform.
    if (!parent.externalCommentId) {
      throw new ReplyTargetNotSyncedError(commentId);
    }

    const platform = parent.platformPost.platform;
    const adapter = this.registry.getAdapter(platform);

    if (parent.depth + 1 > adapter.capabilities.maxReplyDepth) {
      throw new ReplyDepthExceededError(platform, adapter.capabilities.maxReplyDepth);
    }
    if (dto.body.length > adapter.capabilities.maxCommentLength) {
      throw new ReplyBodyTooLongError(platform, adapter.capabilities.maxCommentLength);
    }

    // 1. Persist intent (outbox row).
    let reply;
    try {
      reply = await this.repository.createLocalReply({
        platformPostId: parent.platformPostId,
        parentCommentId: parent.id,
        depth: parent.depth + 1,
        body: dto.body,
        idempotencyKey: idempotencyKey ?? null,
      });
    } catch (e) {
      // Unique-violation race on idempotencyKey: a concurrent duplicate won; replay it.
      if (
        idempotencyKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.repository.findByIdempotencyKey(idempotencyKey);
        if (winner) {
          return {
            reply: CommentResponseDto.from(winner, winner.platformPost.platform),
            replayed: true,
          };
        }
      }
      throw e;
    }

    // 2. Attempt delivery.
    try {
      const delivered = await adapter.postReply({
        externalPostId: parent.platformPost.externalPostId,
        externalParentCommentId: parent.externalCommentId,
        body: dto.body,
      });
      reply = await this.repository.markReplySent(
        reply.id,
        delivered.externalId,
        delivered.publishedAt,
      );
    } catch (e) {
      if (e instanceof PlatformApiError) {
        if (e.retryable) {
          // Stay PENDING: the outbox worker (roadmap) retries with backoff.
          this.logger.warn(`Reply ${reply.id} delivery deferred: ${e.message}`);
        } else {
          reply = await this.repository.markReplyFailed(reply.id, e.message);
        }
      } else {
        reply = await this.repository.markReplyFailed(reply.id, 'Unexpected delivery error');
        this.logger.error(`Reply ${reply.id} delivery error`, e instanceof Error ? e.stack : `${e}`);
      }
    }

    return { reply: CommentResponseDto.from(reply, platform), replayed: false };
  }

  /** Status endpoint — lets clients poll a PENDING reply's delivery outcome. */
  async getCommentById(commentId: string): Promise<CommentResponseDto> {
    const comment = await this.repository.findCommentById(commentId);
    if (!comment) {
      throw new CommentNotFoundError(commentId);
    }
    return CommentResponseDto.from(comment, comment.platformPost.platform);
  }

  /**
   * Pulls the latest comments for one platform publication if the local copy
   * is older than the TTL. Failures degrade to serving cached data.
   */
  private async syncIfStale(platformPost: PlatformPost): Promise<SyncStatusDto> {
    const { platform, commentsSyncedAt } = platformPost;
    const fresh =
      commentsSyncedAt !== null && Date.now() - commentsSyncedAt.getTime() < this.syncTtlMs;
    if (fresh) {
      return { platform, state: 'CACHED', syncedAt: commentsSyncedAt };
    }

    const adapter = this.registry.getAdapter(platform);
    try {
      const { comments } = await adapter.fetchComments(platformPost.externalPostId);
      await this.mirrorComments(platformPost.id, comments);
      const now = new Date();
      await this.repository.markPlatformPostSynced(platformPost.id, now);
      return { platform, state: 'FRESH', syncedAt: now };
    } catch (e) {
      if (e instanceof PlatformApiError && commentsSyncedAt !== null) {
        // Platform down but we have a cached copy -> serve stale, tell the client.
        this.logger.warn(`Serving stale ${platform} comments: ${e.message}`);
        return { platform, state: 'STALE', syncedAt: commentsSyncedAt };
      }
      throw e; // first-ever sync failed: nothing to serve, surface the error
    }
  }

  /**
   * Upserts platform comments locally, resolving external parent IDs to local
   * row IDs. Processes in dependency order so a parent always exists before
   * its replies (platforms can return them interleaved).
   */
  private async mirrorComments(
    platformPostId: string,
    comments: NormalizedPlatformComment[],
  ): Promise<void> {
    const localByExternalId = new Map<string, { id: string; depth: number }>();
    const pending = [...comments];

    while (pending.length > 0) {
      const readyIndex = pending.findIndex(
        (c) => c.externalParentId === null || localByExternalId.has(c.externalParentId),
      );
      const comment =
        readyIndex >= 0
          ? pending.splice(readyIndex, 1)[0]
          : pending.shift()!; // orphan (parent not in payload): treat as top-level

      let parentCommentId: string | null = null;
      let depth = 0;
      if (comment.externalParentId) {
        const parent =
          localByExternalId.get(comment.externalParentId) ??
          (await this.findLocalParent(platformPostId, comment.externalParentId));
        if (parent) {
          parentCommentId = parent.id;
          depth = parent.depth + 1;
        }
      }

      const saved = await this.repository.upsertSyncedComment(
        platformPostId,
        comment,
        parentCommentId,
        depth,
      );
      localByExternalId.set(comment.externalId, { id: saved.id, depth: saved.depth });
    }
  }

  /** Parent may already exist locally from a previous sync or a SENT local reply. */
  private async findLocalParent(
    platformPostId: string,
    externalParentId: string,
  ): Promise<{ id: string; depth: number } | null> {
    const parent = await this.repository.findByExternalId(platformPostId, externalParentId);
    return parent ? { id: parent.id, depth: parent.depth } : null;
  }
}
