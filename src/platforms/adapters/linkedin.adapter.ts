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

/** Shape of a comment as returned by the LinkedIn REST API (subset). */
interface LinkedInRawComment {
  commentUrn: string;
  actor: { urn: string; localizedName: string };
  commentary: { text: string };
  createdAt: number; // epoch millis
  parentComment?: string; // URN of the parent
}

/**
 * Mock LinkedIn adapter.
 *
 * Real implementation would use the socialActions API
 * (GET /socialActions/{shareUrn}/comments, POST …/comments).
 * Note the deliberately different raw shape (URNs, epoch millis, nested
 * commentary object) — the adapter's job is to absorb this variance.
 */
@Injectable()
export class LinkedInAdapter implements SocialPlatformAdapter {
  readonly platform = Platform.LINKEDIN;
  readonly capabilities: PlatformCapabilities = {
    maxReplyDepth: 3,
    maxCommentLength: 3000,
  };

  private readonly store = new Map<string, LinkedInRawComment[]>([
    [
      'urn:li:share:2002',
      [
        {
          commentUrn: 'urn:li:comment:7001',
          actor: { urn: 'urn:li:person:aa1', localizedName: 'Diana Petrescu' },
          commentary: { text: 'Impressive roadmap — congrats to the team.' },
          createdAt: Date.UTC(2026, 6, 10, 12, 0, 0),
        },
        {
          commentUrn: 'urn:li:comment:7002',
          actor: { urn: 'urn:li:person:bb2', localizedName: 'Erik Johansson' },
          commentary: { text: 'Is there an enterprise tier planned?' },
          createdAt: Date.UTC(2026, 6, 11, 8, 45, 0),
        },
      ],
    ],
    [
      'urn:li:share:2010',
      [
        {
          commentUrn: 'urn:li:comment:7050',
          actor: { urn: 'urn:li:person:cc3', localizedName: 'Fatima Khan' },
          commentary: { text: 'Love seeing the engineering culture!' },
          createdAt: Date.UTC(2026, 6, 14, 16, 20, 0),
        },
      ],
    ],
  ]);

  async fetchComments(externalPostId: string): Promise<FetchCommentsResult> {
    await simulateLatency();
    const raw = this.store.get(externalPostId);
    if (!raw) {
      throw new PlatformEntityNotFoundError(this.platform, `share ${externalPostId}`);
    }
    return { comments: raw.map((c) => this.toNormalized(c)) };
  }

  async postReply(input: PostReplyInput): Promise<NormalizedPlatformComment> {
    await simulateLatency();
    simulateReplyErrors(this.platform, input.body);
    const raw = this.store.get(input.externalPostId);
    if (!raw) {
      throw new PlatformEntityNotFoundError(this.platform, `share ${input.externalPostId}`);
    }
    if (!raw.some((c) => c.commentUrn === input.externalParentCommentId)) {
      throw new PlatformEntityNotFoundError(
        this.platform,
        `comment ${input.externalParentCommentId}`,
      );
    }
    const created: LinkedInRawComment = {
      commentUrn: `urn:li:comment:${nextReplyId('li')}`,
      actor: { urn: 'urn:li:organization:42', localizedName: 'Our Company' },
      commentary: { text: input.body },
      createdAt: Date.now(),
      parentComment: input.externalParentCommentId,
    };
    raw.push(created);
    return this.toNormalized(created);
  }

  private toNormalized(c: LinkedInRawComment): NormalizedPlatformComment {
    return {
      externalId: c.commentUrn,
      externalParentId: c.parentComment ?? null,
      authorExternalId: c.actor.urn,
      authorName: c.actor.localizedName,
      body: c.commentary.text,
      publishedAt: new Date(c.createdAt),
    };
  }
}
