import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  Comment,
  CommentSource,
  CommentStatus,
  Platform,
  PlatformPost,
  Post,
  PostStatus,
} from '@prisma/client';
import { CommentsService } from './comments.service';
import { CommentsRepository, CommentWithPlatformPost } from './comments.repository';
import { PlatformAdapterRegistry } from '../platforms/platform-adapter.registry';
import { SocialPlatformAdapter } from '../platforms/platform-adapter.interface';
import { PlatformRateLimitedError, PlatformRejectedError } from '../platforms/platform.errors';
import {
  PostNotFoundError,
  PostNotPublishedError,
  ReplyDepthExceededError,
  ReplyBodyTooLongError,
  ReplyTargetNotSyncedError,
} from '../common/errors/domain.errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const post: Post = {
  id: 'post_1',
  content: 'hello',
  status: PostStatus.PUBLISHED,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const platformPost: PlatformPost = {
  id: 'pp_1',
  postId: 'post_1',
  platform: Platform.FACEBOOK,
  externalPostId: 'fb_post_1',
  publishedAt: new Date('2026-07-01T00:00:00Z'),
  commentsSyncedAt: null,
};

function makeComment(overrides: Partial<Comment> = {}): CommentWithPlatformPost {
  return {
    id: 'c_1',
    platformPostId: 'pp_1',
    externalCommentId: 'fb_c_1',
    parentCommentId: null,
    depth: 0,
    authorExternalId: 'u1',
    authorName: 'Alice',
    body: 'hi',
    source: CommentSource.PLATFORM,
    status: CommentStatus.SYNCED,
    failureReason: null,
    idempotencyKey: null,
    occurredAt: new Date('2026-07-02T00:00:00Z'),
    publishedAt: new Date('2026-07-02T00:00:00Z'),
    syncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    platformPost,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type RepoMock = jest.Mocked<
  Pick<
    CommentsRepository,
    | 'findPostById'
    | 'findPlatformPosts'
    | 'upsertSyncedComment'
    | 'findByExternalId'
    | 'markPlatformPostSynced'
    | 'findTopLevelPage'
    | 'findCommentById'
    | 'findByIdempotencyKey'
    | 'createLocalReply'
    | 'markReplySent'
    | 'markReplyFailed'
  >
>;

function makeRepoMock(): RepoMock {
  return {
    findPostById: jest.fn(),
    findPlatformPosts: jest.fn(),
    upsertSyncedComment: jest.fn(),
    findByExternalId: jest.fn(),
    markPlatformPostSynced: jest.fn(),
    findTopLevelPage: jest.fn(),
    findCommentById: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    createLocalReply: jest.fn(),
    markReplySent: jest.fn(),
    markReplyFailed: jest.fn(),
  };
}

function makeAdapterMock(): jest.Mocked<SocialPlatformAdapter> {
  return {
    platform: Platform.FACEBOOK,
    capabilities: { maxReplyDepth: 2, maxCommentLength: 100 },
    fetchComments: jest.fn().mockResolvedValue({ comments: [] }),
    postReply: jest.fn(),
  };
}

async function makeService(repo: RepoMock, adapter: SocialPlatformAdapter) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      CommentsService,
      { provide: CommentsRepository, useValue: repo },
      {
        provide: PlatformAdapterRegistry,
        useValue: { getAdapter: jest.fn().mockReturnValue(adapter) },
      },
      { provide: ConfigService, useValue: { get: () => 60 } },
    ],
  }).compile();
  return moduleRef.get(CommentsService);
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

describe('CommentsService — getCommentsForPost', () => {
  let repo: RepoMock;
  let adapter: jest.Mocked<SocialPlatformAdapter>;
  let service: CommentsService;

  beforeEach(async () => {
    repo = makeRepoMock();
    adapter = makeAdapterMock();
    service = await makeService(repo, adapter);
  });

  it('rejects unknown posts', async () => {
    repo.findPostById.mockResolvedValue(null);
    await expect(service.getCommentsForPost('nope', {})).rejects.toThrow(PostNotFoundError);
  });

  it('rejects unpublished posts', async () => {
    repo.findPostById.mockResolvedValue({ ...post, status: PostStatus.DRAFT });
    await expect(service.getCommentsForPost('post_1', {})).rejects.toThrow(PostNotPublishedError);
  });

  it('syncs from the platform when the cache is stale, then serves locally', async () => {
    repo.findPostById.mockResolvedValue(post);
    repo.findPlatformPosts.mockResolvedValue([platformPost]); // commentsSyncedAt: null => stale
    adapter.fetchComments.mockResolvedValue({
      comments: [
        {
          externalId: 'fb_c_1',
          externalParentId: null,
          authorExternalId: 'u1',
          authorName: 'Alice',
          body: 'hi',
          publishedAt: new Date('2026-07-02T00:00:00Z'),
        },
      ],
    });
    repo.upsertSyncedComment.mockResolvedValue(makeComment());
    repo.markPlatformPostSynced.mockResolvedValue(platformPost);
    repo.findTopLevelPage.mockResolvedValue([{ ...makeComment(), replies: [] }]);

    const result = await service.getCommentsForPost('post_1', {});

    expect(adapter.fetchComments).toHaveBeenCalledWith('fb_post_1');
    expect(repo.upsertSyncedComment).toHaveBeenCalledTimes(1);
    expect(result.meta.syncStatus).toEqual([
      expect.objectContaining({ platform: Platform.FACEBOOK, state: 'FRESH' }),
    ]);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].body).toBe('hi');
  });

  it('skips the platform call when the cache is fresh (CACHED)', async () => {
    repo.findPostById.mockResolvedValue(post);
    repo.findPlatformPosts.mockResolvedValue([
      { ...platformPost, commentsSyncedAt: new Date() }, // just synced
    ]);
    repo.findTopLevelPage.mockResolvedValue([]);

    const result = await service.getCommentsForPost('post_1', {});

    expect(adapter.fetchComments).not.toHaveBeenCalled();
    expect(result.meta.syncStatus[0].state).toBe('CACHED');
  });

  it('serves stale data when the platform is down but a cache exists (STALE)', async () => {
    const lastSync = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago, past TTL
    repo.findPostById.mockResolvedValue(post);
    repo.findPlatformPosts.mockResolvedValue([{ ...platformPost, commentsSyncedAt: lastSync }]);
    adapter.fetchComments.mockRejectedValue(new PlatformRateLimitedError(Platform.FACEBOOK));
    repo.findTopLevelPage.mockResolvedValue([{ ...makeComment(), replies: [] }]);

    const result = await service.getCommentsForPost('post_1', {});

    expect(result.meta.syncStatus[0]).toEqual(
      expect.objectContaining({ state: 'STALE', syncedAt: lastSync }),
    );
    expect(result.data).toHaveLength(1);
  });

  it('surfaces the platform error when the FIRST sync fails (no cache to fall back on)', async () => {
    repo.findPostById.mockResolvedValue(post);
    repo.findPlatformPosts.mockResolvedValue([platformPost]); // never synced
    adapter.fetchComments.mockRejectedValue(new PlatformRateLimitedError(Platform.FACEBOOK));

    await expect(service.getCommentsForPost('post_1', {})).rejects.toThrow(
      PlatformRateLimitedError,
    );
  });

  it('links replies to parents during sync regardless of payload order', async () => {
    repo.findPostById.mockResolvedValue(post);
    repo.findPlatformPosts.mockResolvedValue([platformPost]);
    // Child arrives BEFORE its parent in the payload.
    adapter.fetchComments.mockResolvedValue({
      comments: [
        {
          externalId: 'fb_c_2',
          externalParentId: 'fb_c_1',
          authorExternalId: 'u2',
          authorName: 'Bob',
          body: 'reply',
          publishedAt: new Date(),
        },
        {
          externalId: 'fb_c_1',
          externalParentId: null,
          authorExternalId: 'u1',
          authorName: 'Alice',
          body: 'parent',
          publishedAt: new Date(),
        },
      ],
    });
    repo.findByExternalId.mockResolvedValue(null);
    repo.upsertSyncedComment
      .mockResolvedValueOnce(makeComment({ id: 'local_parent', externalCommentId: 'fb_c_1' }))
      .mockResolvedValueOnce(
        makeComment({ id: 'local_child', externalCommentId: 'fb_c_2', depth: 1 }),
      );
    repo.markPlatformPostSynced.mockResolvedValue(platformPost);
    repo.findTopLevelPage.mockResolvedValue([]);

    await service.getCommentsForPost('post_1', {});

    // Parent was persisted first, child second with parent's local id + depth 1.
    expect(repo.upsertSyncedComment).toHaveBeenNthCalledWith(
      1,
      'pp_1',
      expect.objectContaining({ externalId: 'fb_c_1' }),
      null,
      0,
    );
    expect(repo.upsertSyncedComment).toHaveBeenNthCalledWith(
      2,
      'pp_1',
      expect.objectContaining({ externalId: 'fb_c_2' }),
      'local_parent',
      1,
    );
  });

  it('emits a nextCursor only when more rows exist', async () => {
    repo.findPostById.mockResolvedValue(post);
    repo.findPlatformPosts.mockResolvedValue([{ ...platformPost, commentsSyncedAt: new Date() }]);
    // limit=1, repo returns limit+1 rows => next page exists
    repo.findTopLevelPage.mockResolvedValue([
      { ...makeComment({ id: 'c_1' }), replies: [] },
      { ...makeComment({ id: 'c_2' }), replies: [] },
    ]);

    const result = await service.getCommentsForPost('post_1', { limit: 1 });

    expect(result.data).toHaveLength(1);
    expect(result.meta.nextCursor).toEqual(expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// Write path (outbox)
// ---------------------------------------------------------------------------

describe('CommentsService — replyToComment', () => {
  let repo: RepoMock;
  let adapter: jest.Mocked<SocialPlatformAdapter>;
  let service: CommentsService;

  beforeEach(async () => {
    repo = makeRepoMock();
    adapter = makeAdapterMock();
    service = await makeService(repo, adapter);
  });

  it('persists PENDING first, then promotes to SENT on successful delivery', async () => {
    repo.findCommentById.mockResolvedValue(makeComment());
    const pending = makeComment({
      id: 'r_1',
      source: CommentSource.LOCAL,
      status: CommentStatus.PENDING,
      externalCommentId: null,
      depth: 1,
    });
    repo.createLocalReply.mockResolvedValue(pending);
    adapter.postReply.mockResolvedValue({
      externalId: 'fb_new_1',
      externalParentId: 'fb_c_1',
      authorExternalId: 'page',
      authorName: 'Us',
      body: 'thanks!',
      publishedAt: new Date(),
    });
    repo.markReplySent.mockResolvedValue({
      ...pending,
      status: CommentStatus.SENT,
      externalCommentId: 'fb_new_1',
    });

    const { reply, replayed } = await service.replyToComment('c_1', { body: 'thanks!' });

    expect(repo.createLocalReply).toHaveBeenCalledWith(
      expect.objectContaining({ parentCommentId: 'c_1', depth: 1, body: 'thanks!' }),
    );
    expect(adapter.postReply).toHaveBeenCalledWith({
      externalPostId: 'fb_post_1',
      externalParentCommentId: 'fb_c_1',
      body: 'thanks!',
    });
    expect(reply.status).toBe(CommentStatus.SENT);
    expect(replayed).toBe(false);
  });

  it('keeps the reply PENDING on a retryable platform error (rate limit)', async () => {
    repo.findCommentById.mockResolvedValue(makeComment());
    const pending = makeComment({ id: 'r_1', status: CommentStatus.PENDING });
    repo.createLocalReply.mockResolvedValue(pending);
    adapter.postReply.mockRejectedValue(new PlatformRateLimitedError(Platform.FACEBOOK));

    const { reply } = await service.replyToComment('c_1', { body: 'hi' });

    expect(reply.status).toBe(CommentStatus.PENDING);
    expect(repo.markReplyFailed).not.toHaveBeenCalled(); // intent preserved for retry
  });

  it('marks the reply FAILED on a permanent platform rejection', async () => {
    repo.findCommentById.mockResolvedValue(makeComment());
    repo.createLocalReply.mockResolvedValue(makeComment({ id: 'r_1' }));
    adapter.postReply.mockRejectedValue(new PlatformRejectedError(Platform.FACEBOOK, 'policy'));
    repo.markReplyFailed.mockResolvedValue(
      makeComment({ id: 'r_1', status: CommentStatus.FAILED, failureReason: 'policy' }),
    );

    const { reply } = await service.replyToComment('c_1', { body: 'hi' });

    expect(reply.status).toBe(CommentStatus.FAILED);
    expect(repo.markReplyFailed).toHaveBeenCalledWith('r_1', expect.stringContaining('policy'));
  });

  it('replays an existing reply for a known Idempotency-Key without touching the platform', async () => {
    const existing = makeComment({ id: 'r_1', status: CommentStatus.SENT, idempotencyKey: 'k1' });
    repo.findByIdempotencyKey.mockResolvedValue(existing);

    const { reply, replayed } = await service.replyToComment('c_1', { body: 'hi' }, 'k1');

    expect(replayed).toBe(true);
    expect(reply.id).toBe('r_1');
    expect(repo.createLocalReply).not.toHaveBeenCalled();
    expect(adapter.postReply).not.toHaveBeenCalled();
  });

  it('enforces the platform max reply depth', async () => {
    repo.findCommentById.mockResolvedValue(makeComment({ depth: 2 })); // adapter allows 2
    await expect(service.replyToComment('c_1', { body: 'too deep' })).rejects.toThrow(
      ReplyDepthExceededError,
    );
    expect(repo.createLocalReply).not.toHaveBeenCalled();
  });

  it('enforces the platform max comment length', async () => {
    repo.findCommentById.mockResolvedValue(makeComment());
    await expect(
      service.replyToComment('c_1', { body: 'x'.repeat(101) }), // adapter allows 100
    ).rejects.toThrow(ReplyBodyTooLongError);
  });

  it('rejects replying to a comment that has no platform identity yet', async () => {
    repo.findCommentById.mockResolvedValue(
      makeComment({ externalCommentId: null, status: CommentStatus.PENDING }),
    );
    await expect(service.replyToComment('c_1', { body: 'hi' })).rejects.toThrow(
      ReplyTargetNotSyncedError,
    );
  });
});
