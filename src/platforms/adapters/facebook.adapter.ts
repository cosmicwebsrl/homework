import { Injectable } from '@nestjs/common';
import { Platform } from '@prisma/client';
import {
  FetchCommentsResult,
  NormalizedPlatformComment,
  PlatformCapabilities,
  PostReplyInput,
  SocialPlatformAdapter,
} from '../platform-adapter.interface';
import { PlatformEntityNotFoundError } from '../platform.errors';
import { nextReplyId, simulateLatency, simulateReplyErrors } from './mock.helpers';

/** Shape of a comment as returned by the Facebook Graph API (subset). */
interface FacebookRawComment {
  id: string;
  from: { id: string; name: string };
  message: string;
  created_time: string; // ISO-8601
  parent?: { id: string };
}

/**
 * Mock Facebook adapter.
 *
 * In production this would call the Graph API
 * (GET /{post-id}/comments, POST /{comment-id}/comments) with a page access
 * token. Here it serves an in-memory fixture shaped exactly like Graph API
 * responses, and maps it to the normalized domain shape — which is precisely
 * the mapping code a real adapter would contain.
 */
@Injectable()
export class FacebookAdapter implements SocialPlatformAdapter {
  readonly platform = Platform.FACEBOOK;
  readonly capabilities: PlatformCapabilities = {
    maxReplyDepth: 2, // FB supports replies-to-replies (rendered flat beyond level 2)
    maxCommentLength: 8000,
  };

  /** Fixture keyed by external post ID. */
  private readonly store = new Map<string, FacebookRawComment[]>([
    [
      'fb_post_1001',
      [
        {
          id: 'fb_comment_501',
          from: { id: 'fb_user_9', name: 'Alice Martin' },
          message: 'Congrats on the launch! 🎉',
          created_time: '2026-07-10T10:15:00+0000',
        },
        {
          id: 'fb_comment_502',
          from: { id: 'fb_user_12', name: 'Bogdan Ionescu' },
          message: 'Does it ship to Europe?',
          created_time: '2026-07-10T11:02:00+0000',
        },
        {
          id: 'fb_comment_503',
          from: { id: 'fb_user_31', name: 'Carla Diaz' },
          message: 'Same question as Bogdan!',
          created_time: '2026-07-10T11:30:00+0000',
          parent: { id: 'fb_comment_502' },
        },
      ],
    ],
  ]);

  async fetchComments(externalPostId: string): Promise<FetchCommentsResult> {
    await simulateLatency();
    const raw = this.store.get(externalPostId);
    if (!raw) {
      throw new PlatformEntityNotFoundError(this.platform, `post ${externalPostId}`);
    }
    return { comments: raw.map((c) => this.toNormalized(c)) };
  }

  async postReply(input: PostReplyInput): Promise<NormalizedPlatformComment> {
    await simulateLatency();
    simulateReplyErrors(this.platform, input.body);
    const raw = this.store.get(input.externalPostId);
    if (!raw) {
      throw new PlatformEntityNotFoundError(this.platform, `post ${input.externalPostId}`);
    }
    if (!raw.some((c) => c.id === input.externalParentCommentId)) {
      throw new PlatformEntityNotFoundError(
        this.platform,
        `comment ${input.externalParentCommentId}`,
      );
    }
    const created: FacebookRawComment = {
      id: nextReplyId('fb_comment'),
      from: { id: 'fb_page_1', name: 'Our Brand Page' },
      message: input.body,
      created_time: new Date().toISOString(),
      parent: { id: input.externalParentCommentId },
    };
    raw.push(created);
    return this.toNormalized(created);
  }

  private toNormalized(c: FacebookRawComment): NormalizedPlatformComment {
    return {
      externalId: c.id,
      externalParentId: c.parent?.id ?? null,
      authorExternalId: c.from.id,
      authorName: c.from.name,
      body: c.message,
      publishedAt: new Date(c.created_time),
    };
  }
}
