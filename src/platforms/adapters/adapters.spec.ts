import { Platform } from '@prisma/client';
import { FacebookAdapter } from './facebook.adapter';
import { LinkedInAdapter } from './linkedin.adapter';
import { InstagramAdapter } from './instagram.adapter';
import {
  PlatformEntityNotFoundError,
  PlatformRateLimitedError,
  PlatformRejectedError,
} from '../platform.errors';

describe('platform adapters — payload normalization', () => {
  it('Facebook: maps Graph API shape (from/message/created_time) to the domain shape', async () => {
    const { comments } = await new FacebookAdapter().fetchComments('fb_post_1001');
    const reply = comments.find((c) => c.externalId === 'fb_comment_503');
    expect(reply).toEqual({
      externalId: 'fb_comment_503',
      externalParentId: 'fb_comment_502', // FB `parent.id`
      authorExternalId: 'fb_user_31',
      authorName: 'Carla Diaz',
      body: 'Same question as Bogdan!',
      publishedAt: new Date('2026-07-10T11:30:00+0000'),
    });
  });

  it('LinkedIn: maps URN/epoch-millis shape to the domain shape', async () => {
    const { comments } = await new LinkedInAdapter().fetchComments('urn:li:share:2002');
    expect(comments[0]).toEqual(
      expect.objectContaining({
        externalId: 'urn:li:comment:7001',
        authorExternalId: 'urn:li:person:aa1',
        authorName: 'Diana Petrescu',
        publishedAt: new Date(Date.UTC(2026, 6, 10, 12, 0, 0)),
      }),
    );
  });

  it('Instagram: flattens nested replies into the flat normalized list', async () => {
    const { comments } = await new InstagramAdapter().fetchComments('ig_media_3003');
    const reply = comments.find((c) => c.externalId === 'ig_comment_802');
    expect(reply?.externalParentId).toBe('ig_comment_801'); // parent inferred from nesting
    expect(comments.filter((c) => c.externalParentId === null)).toHaveLength(2);
  });

  it('throws a normalized not-found error for unknown posts', async () => {
    await expect(new FacebookAdapter().fetchComments('missing')).rejects.toThrow(
      PlatformEntityNotFoundError,
    );
  });
});

describe('platform adapters — replies', () => {
  it('creates a reply and returns its platform identity', async () => {
    const adapter = new FacebookAdapter();
    const created = await adapter.postReply({
      externalPostId: 'fb_post_1001',
      externalParentCommentId: 'fb_comment_501',
      body: 'Thank you!',
    });
    expect(created.externalId).toMatch(/^fb_comment_/);
    expect(created.externalParentId).toBe('fb_comment_501');

    // The reply is visible on a subsequent fetch (mock behaves like the real platform).
    const { comments } = await adapter.fetchComments('fb_post_1001');
    expect(comments.some((c) => c.externalId === created.externalId)).toBe(true);
  });

  it('simulates retryable and permanent failures via magic strings', async () => {
    const adapter = new LinkedInAdapter();
    const base = {
      externalPostId: 'urn:li:share:2002',
      externalParentCommentId: 'urn:li:comment:7001',
    };
    await expect(
      adapter.postReply({ ...base, body: 'x [simulate:rate-limit]' }),
    ).rejects.toThrow(PlatformRateLimitedError);
    await expect(adapter.postReply({ ...base, body: 'x [simulate:rejected]' })).rejects.toThrow(
      PlatformRejectedError,
    );
  });

  it('rejects replies to comments that do not exist on the platform', async () => {
    await expect(
      new InstagramAdapter().postReply({
        externalPostId: 'ig_media_3003',
        externalParentCommentId: 'ig_missing',
        body: 'hi',
      }),
    ).rejects.toThrow(PlatformEntityNotFoundError);
  });
});

describe('platform adapters — capabilities', () => {
  it('declares per-platform limits used by the domain layer', () => {
    expect(new InstagramAdapter().capabilities.maxReplyDepth).toBe(1);
    expect(new FacebookAdapter().capabilities.maxReplyDepth).toBe(2);
    expect(new LinkedInAdapter().capabilities.maxCommentLength).toBe(3000);
  });

  it('each adapter self-identifies its platform (registry contract)', () => {
    expect(new FacebookAdapter().platform).toBe(Platform.FACEBOOK);
    expect(new LinkedInAdapter().platform).toBe(Platform.LINKEDIN);
    expect(new InstagramAdapter().platform).toBe(Platform.INSTAGRAM);
  });
});
