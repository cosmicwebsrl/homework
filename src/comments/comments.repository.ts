import { Injectable } from '@nestjs/common';
import {
  Comment,
  CommentSource,
  CommentStatus,
  Platform,
  PlatformPost,
  Post,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CursorPayload } from '../common/pagination/cursor';
import { NormalizedPlatformComment } from '../platforms/platform-adapter.interface';

export type PlatformPostWithPost = PlatformPost & { post: Post };
export type CommentWithPlatformPost = Comment & { platformPost: PlatformPost };
export type CommentWithReplies = Comment & { replies: Comment[] };

/**
 * Thin data-access layer. Keeps Prisma specifics out of the service so the
 * domain logic stays testable with a simple mock.
 */
@Injectable()
export class CommentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findPostById(postId: string): Promise<Post | null> {
    return this.prisma.post.findUnique({ where: { id: postId } });
  }

  findPlatformPosts(postId: string, platform?: Platform): Promise<PlatformPost[]> {
    return this.prisma.platformPost.findMany({
      where: { postId, ...(platform && { platform }) },
      orderBy: { platform: 'asc' },
    });
  }

  /**
   * Idempotently mirrors one platform comment into the local store.
   * Upsert keyed by (platformPostId, externalCommentId) makes re-syncs safe.
   */
  upsertSyncedComment(
    platformPostId: string,
    comment: NormalizedPlatformComment,
    parentCommentId: string | null,
    depth: number,
  ): Promise<Comment> {
    const now = new Date();
    return this.prisma.comment.upsert({
      where: {
        platformPostId_externalCommentId: {
          platformPostId,
          externalCommentId: comment.externalId,
        },
      },
      // Content the platform owns may change (edits); our local identity may not.
      update: {
        body: comment.body,
        authorName: comment.authorName,
        syncedAt: now,
      },
      create: {
        platformPostId,
        externalCommentId: comment.externalId,
        parentCommentId,
        depth,
        authorExternalId: comment.authorExternalId,
        authorName: comment.authorName,
        body: comment.body,
        source: CommentSource.PLATFORM,
        status: CommentStatus.SYNCED,
        occurredAt: comment.publishedAt,
        publishedAt: comment.publishedAt,
        syncedAt: now,
      },
    });
  }

  findByExternalId(platformPostId: string, externalCommentId: string): Promise<Comment | null> {
    return this.prisma.comment.findUnique({
      where: {
        platformPostId_externalCommentId: { platformPostId, externalCommentId },
      },
    });
  }

  markPlatformPostSynced(platformPostId: string, at: Date): Promise<PlatformPost> {
    return this.prisma.platformPost.update({
      where: { id: platformPostId },
      data: { commentsSyncedAt: at },
    });
  }

  /**
   * Keyset-paginated page of top-level comments (optionally with nested replies),
   * ordered chronologically. `limit + 1` rows are fetched to detect a next page.
   */
  async findTopLevelPage(params: {
    platformPostIds: string[];
    cursor: CursorPayload | null;
    limit: number;
    includeReplies: boolean;
  }): Promise<CommentWithReplies[]> {
    const { platformPostIds, cursor, limit, includeReplies } = params;
    const where: Prisma.CommentWhereInput = {
      platformPostId: { in: platformPostIds },
      parentCommentId: null,
      ...(cursor && {
        OR: [
          { occurredAt: { gt: cursor.occurredAt } },
          { occurredAt: cursor.occurredAt, id: { gt: cursor.id } },
        ],
      }),
    };
    const orderBy: Prisma.CommentOrderByWithRelationInput[] = [
      { occurredAt: 'asc' },
      { id: 'asc' },
    ];
    if (includeReplies) {
      return this.prisma.comment.findMany({
        where,
        orderBy,
        take: limit + 1,
        include: { replies: { orderBy } },
      });
    }
    const rows = await this.prisma.comment.findMany({ where, orderBy, take: limit + 1 });
    return rows.map((r) => ({ ...r, replies: [] }));
  }

  findCommentById(commentId: string): Promise<CommentWithPlatformPost | null> {
    return this.prisma.comment.findUnique({
      where: { id: commentId },
      include: { platformPost: true },
    });
  }

  findByIdempotencyKey(key: string): Promise<CommentWithPlatformPost | null> {
    return this.prisma.comment.findUnique({
      where: { idempotencyKey: key },
      include: { platformPost: true },
    });
  }

  createLocalReply(params: {
    platformPostId: string;
    parentCommentId: string;
    depth: number;
    body: string;
    idempotencyKey: string | null;
  }): Promise<Comment> {
    return this.prisma.comment.create({
      data: {
        platformPostId: params.platformPostId,
        parentCommentId: params.parentCommentId,
        depth: params.depth,
        authorExternalId: null,
        authorName: 'Scheduler User', // stand-in: would come from the authenticated user
        body: params.body,
        source: CommentSource.LOCAL,
        status: CommentStatus.PENDING,
        idempotencyKey: params.idempotencyKey,
        occurredAt: new Date(),
      },
    });
  }

  markReplySent(
    commentId: string,
    externalCommentId: string,
    publishedAt: Date,
  ): Promise<Comment> {
    return this.prisma.comment.update({
      where: { id: commentId },
      data: {
        status: CommentStatus.SENT,
        externalCommentId,
        publishedAt,
        syncedAt: new Date(),
        failureReason: null,
      },
    });
  }

  markReplyFailed(commentId: string, reason: string): Promise<Comment> {
    return this.prisma.comment.update({
      where: { id: commentId },
      data: { status: CommentStatus.FAILED, failureReason: reason },
    });
  }
}
