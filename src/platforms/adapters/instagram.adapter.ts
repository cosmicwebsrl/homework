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

/** Shape of a comment from the Instagram Graph API (subset). Replies arrive NESTED. */
interface InstagramRawComment {
  id: string;
  username: string;
  text: string;
  timestamp: string; // ISO-8601
  replies?: { data: InstagramRawComment[] };
}

/**
 * Mock Instagram adapter.
 *
 * Instagram is the "awkward" platform on purpose:
 *  - replies are nested inside the parent payload (must be flattened),
 *  - only ONE level of threading is allowed (capability enforced upstream),
 *  - no stable author ID beyond username.
 * It demonstrates that the normalized model can absorb platform quirks.
 */
@Injectable()
export class InstagramAdapter implements SocialPlatformAdapter {
  readonly platform = Platform.INSTAGRAM;
  readonly capabilities: PlatformCapabilities = {
    maxReplyDepth: 1, // IG only supports replying to top-level comments
    maxCommentLength: 2200,
  };

  private readonly store = new Map<string, InstagramRawComment[]>([
    [
      'ig_media_3003',
      [
        {
          id: 'ig_comment_801',
          username: 'gina.travels',
          text: 'This looks amazing 😍',
          timestamp: '2026-07-10T13:05:00+0000',
          replies: {
            data: [
              {
                id: 'ig_comment_802',
                username: 'our.brand',
                text: 'Thank you Gina! ❤️',
                timestamp: '2026-07-10T13:20:00+0000',
              },
            ],
          },
        },
        {
          id: 'ig_comment_803',
          username: 'hans_m',
          text: 'Price?',
          timestamp: '2026-07-10T15:40:00+0000',
        },
      ],
    ],
  ]);

  async fetchComments(externalPostId: string): Promise<FetchCommentsResult> {
    await simulateLatency();
    const raw = this.store.get(externalPostId);
    if (!raw) {
      throw new PlatformEntityNotFoundError(this.platform, `media ${externalPostId}`);
    }
    // Flatten IG's nested reply structure into the normalized flat list.
    const comments: NormalizedPlatformComment[] = [];
    for (const top of raw) {
      comments.push(this.toNormalized(top, null));
      for (const reply of top.replies?.data ?? []) {
        comments.push(this.toNormalized(reply, top.id));
      }
    }
    return { comments };
  }

  async postReply(input: PostReplyInput): Promise<NormalizedPlatformComment> {
    await simulateLatency();
    simulateReplyErrors(this.platform, input.body);
    const raw = this.store.get(input.externalPostId);
    if (!raw) {
      throw new PlatformEntityNotFoundError(this.platform, `media ${input.externalPostId}`);
    }
    const parent = raw.find((c) => c.id === input.externalParentCommentId);
    if (!parent) {
      throw new PlatformEntityNotFoundError(
        this.platform,
        `comment ${input.externalParentCommentId}`,
      );
    }
    const created: InstagramRawComment = {
      id: nextReplyId('ig_comment'),
      username: 'our.brand',
      text: input.body,
      timestamp: new Date().toISOString(),
    };
    parent.replies = parent.replies ?? { data: [] };
    parent.replies.data.push(created);
    return this.toNormalized(created, parent.id);
  }

  private toNormalized(
    c: InstagramRawComment,
    parentId: string | null,
  ): NormalizedPlatformComment {
    return {
      externalId: c.id,
      externalParentId: parentId,
      authorExternalId: c.username, // IG exposes no stable numeric ID for commenters
      authorName: c.username,
      body: c.text,
      publishedAt: new Date(c.timestamp),
    };
  }
}
