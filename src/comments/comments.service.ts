import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Comment, Platform, PlatformPost, PostStatus, Prisma } from '@prisma/client';
import { CommentsRepository, CommentWithPlatformPost } from './comments.repository';
import { PlatformAdapterRegistry } from '../platforms/platform-adapter.registry';
import { NormalizedPlatformComment } from '../platforms/platform-adapter.interface';
import { PlatformApiError } from '../platforms/platform.errors';
import {
  CommentNotFoundError,
  IdempotencyKeyConflictError,
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
    // Env values arrive as strings — coerce explicitly rather than relying on `*`.
    this.syncTtlMs = Number(config.get('COMMENTS_SYNC_TTL_SECONDS') ?? 60) * 1000;
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

    // Platforms are independent — sync them concurrently; total latency is the
    // slowest platform's, not the sum. Order of syncStatus matches platformPosts.
    const syncStatus = await Promise.all(platformPosts.map((pp) => this.syncIfStale(pp)));

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
        // Non-null: every row was selected by platformPostId ∈ platformPosts.
        CommentResponseDto.from(c, platformByPostId.get(c.platformPostId)!),
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
        return this.replayReply(existing, commentId, dto);
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
    let reply: Comment;
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
          return this.replayReply(winner, commentId, dto);
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
   * Replays a previously stored reply for an Idempotency-Key — but only if the
   * request is actually the same one. Reusing a key with a different target or
   * body is a client bug and must fail loudly, not silently return stale data.
   */
  private replayReply(
    existing: CommentWithPlatformPost,
    commentId: string,
    dto: CreateReplyDto,
  ): ReplyResult {
    if (existing.parentCommentId !== commentId || existing.body !== dto.body) {
      throw new IdempotencyKeyConflictError();
    }
    return {
      reply: CommentResponseDto.from(existing, existing.platformPost.platform),
      replayed: true,
    };
  }

  /**
   * Stampede guard: concurrent requests for the same stale platform post share
   * ONE in-flight sync instead of each hitting the platform (wasting rate-limit
   * budget on identical work). Scoped to this process — multi-instance
   * deployments would add a distributed lock or route syncs through a queue
   * (see roadmap); the upserts are idempotent either way, so this is purely an
   * efficiency concern, never a correctness one.
   */
  private readonly inflightSyncs = new Map<string, Promise<SyncStatusDto>>();

  private syncIfStale(platformPost: PlatformPost): Promise<SyncStatusDto> {
    const inflight = this.inflightSyncs.get(platformPost.id);
    if (inflight) {
      return inflight;
    }
    const sync = this.doSyncIfStale(platformPost).finally(() =>
      this.inflightSyncs.delete(platformPost.id),
    );
    this.inflightSyncs.set(platformPost.id, sync);
    return sync;
  }

  /**
   * Pulls the latest comments for one platform publication if the local copy
   * is older than the TTL. Failures degrade to serving cached data.
   */
  private async doSyncIfStale(platformPost: PlatformPost): Promise<SyncStatusDto> {
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
   * row IDs. Processes in dependency **waves**: every comment whose parent is
   * already resolvable is persisted concurrently, then the next wave runs —
   * so a payload of T top-level comments + R replies costs 2 concurrent waves
   * rather than T+R sequential round trips.
   *
   * A comment is ready when its parent is null, already persisted, or not
   * present in this payload at all (a true orphan — resolved via the DB or
   * degraded to top-level). Children whose parent is elsewhere in the payload
   * wait for the parent's wave, so payload order never corrupts threading.
   */
  private async mirrorComments(
    platformPostId: string,
    comments: NormalizedPlatformComment[],
  ): Promise<void> {
    const payloadIds = new Set(comments.map((c) => c.externalId));
    const localByExternalId = new Map<string, { id: string; depth: number }>();
    let pending = [...comments];

    while (pending.length > 0) {
      const ready = pending.filter(
        (c) =>
          c.externalParentId === null ||
          localByExternalId.has(c.externalParentId) ||
          !payloadIds.has(c.externalParentId), // true orphan: parent not in payload
      );
      // Empty only on a parent cycle (malformed payload): force progress.
      const wave = ready.length > 0 ? ready : [pending[0]];
      const waveIds = new Set(wave.map((c) => c.externalId));
      pending = pending.filter((c) => !waveIds.has(c.externalId));

      await Promise.all(
        wave.map(async (comment) => {
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
        }),
      );
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
