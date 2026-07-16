import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Platform, PostStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * End-to-end tests: real HTTP -> NestJS -> Prisma -> PostgreSQL (test DB),
 * with the mock platform adapters standing in for the social networks.
 */
describe('Comments API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    await seed(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seed(db: PrismaService): Promise<void> {
    await db.comment.deleteMany();
    await db.platformPost.deleteMany();
    await db.post.deleteMany();
    await db.post.create({
      data: {
        id: 'post_published_1',
        content: 'Launch post',
        status: PostStatus.PUBLISHED,
        platformPosts: {
          create: [
            {
              id: 'pp_fb_1',
              platform: Platform.FACEBOOK,
              externalPostId: 'fb_post_1001',
              publishedAt: new Date('2026-07-10T09:00:00Z'),
            },
            {
              id: 'pp_li_1',
              platform: Platform.LINKEDIN,
              externalPostId: 'urn:li:share:2002',
              publishedAt: new Date('2026-07-10T09:00:05Z'),
            },
            {
              id: 'pp_ig_1',
              platform: Platform.INSTAGRAM,
              externalPostId: 'ig_media_3003',
              publishedAt: new Date('2026-07-10T09:00:10Z'),
            },
          ],
        },
      },
    });
    await db.post.create({
      data: { id: 'post_draft_1', content: 'Draft', status: PostStatus.DRAFT },
    });
  }

  describe('GET /api/health', () => {
    it('reports service and database health', async () => {
      const res = await request(app.getHttpServer()).get('/api/health').expect(200);
      expect(res.body).toEqual({ status: 'ok', db: 'up' });
    });
  });

  describe('GET /api/v1/posts/:postId/comments', () => {
    it('aggregates comments from all platforms on first read (sync-on-read)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/posts/post_published_1/comments')
        .expect(200);

      const platforms = new Set(res.body.data.map((c: { platform: string }) => c.platform));
      expect(platforms).toEqual(new Set(['FACEBOOK', 'LINKEDIN', 'INSTAGRAM']));
      expect(res.body.meta.syncStatus).toHaveLength(3);
      expect(res.body.meta.syncStatus.every((s: { state: string }) => s.state === 'FRESH')).toBe(
        true,
      );
      // Chronological order across platforms
      const times = res.body.data.map((c: { occurredAt: string }) => c.occurredAt);
      expect([...times].sort()).toEqual(times);
    });

    it('serves from cache within the TTL (CACHED)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/posts/post_published_1/comments')
        .expect(200);
      expect(res.body.meta.syncStatus.every((s: { state: string }) => s.state === 'CACHED')).toBe(
        true,
      );
    });

    it('nests replies under their parent and marks depth', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/posts/post_published_1/comments?platform=INSTAGRAM')
        .expect(200);
      const withReply = res.body.data.find(
        (c: { replies: unknown[] }) => c.replies.length > 0,
      );
      expect(withReply).toBeDefined();
      expect(withReply.depth).toBe(0);
      expect(withReply.replies[0].depth).toBe(1);
      expect(withReply.replies[0].parentCommentId).toBe(withReply.id);
    });

    it('paginates with a stable cursor and no duplicates', async () => {
      const page1 = await request(app.getHttpServer())
        .get('/api/v1/posts/post_published_1/comments?limit=2')
        .expect(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.nextCursor).toBeTruthy();

      const page2 = await request(app.getHttpServer())
        .get(
          `/api/v1/posts/post_published_1/comments?limit=2&cursor=${encodeURIComponent(
            page1.body.meta.nextCursor,
          )}`,
        )
        .expect(200);

      const ids1 = page1.body.data.map((c: { id: string }) => c.id);
      const ids2 = page2.body.data.map((c: { id: string }) => c.id);
      expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
    });

    it('filters by platform', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/posts/post_published_1/comments?platform=LINKEDIN')
        .expect(200);
      expect(res.body.data.every((c: { platform: string }) => c.platform === 'LINKEDIN')).toBe(
        true,
      );
    });

    it('returns problem details: 404 unknown post, 409 draft post, 400 bad cursor/platform', async () => {
      await request(app.getHttpServer()).get('/api/v1/posts/ghost/comments').expect(404);

      const draft = await request(app.getHttpServer())
        .get('/api/v1/posts/post_draft_1/comments')
        .expect(409);
      expect(draft.body.title).toBe('POST_NOT_PUBLISHED');

      const badCursor = await request(app.getHttpServer())
        .get('/api/v1/posts/post_published_1/comments?cursor=%%%')
        .expect(400);
      expect(badCursor.body.title).toBe('INVALID_CURSOR');

      await request(app.getHttpServer())
        .get('/api/v1/posts/post_published_1/comments?platform=MYSPACE')
        .expect(400);
    });
  });

  describe('POST /api/v1/comments/:commentId/replies', () => {
    let parentId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/posts/post_published_1/comments?platform=FACEBOOK')
        .expect(200);
      parentId = res.body.data[0].id;
    });

    it('202 + Location: persists the reply and delivers it (SENT)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/comments/${parentId}/replies`)
        .send({ body: 'Thanks for the kind words!' })
        .expect(202);

      expect(res.headers.location).toBe(`/api/v1/comments/${res.body.id}`);
      expect(res.body).toMatchObject({
        source: 'LOCAL',
        status: 'SENT',
        parentCommentId: parentId,
        depth: 1,
      });
      expect(res.body.externalCommentId).toBeTruthy();
    });

    it('replays the original reply for a duplicate Idempotency-Key', async () => {
      const key = `e2e-key-${Date.now()}`;
      const first = await request(app.getHttpServer())
        .post(`/api/v1/comments/${parentId}/replies`)
        .set('Idempotency-Key', key)
        .send({ body: 'Only once please' })
        .expect(202);

      const replay = await request(app.getHttpServer())
        .post(`/api/v1/comments/${parentId}/replies`)
        .set('Idempotency-Key', key)
        .send({ body: 'Only once please' })
        .expect(202);

      expect(replay.body.id).toBe(first.body.id);
      expect(replay.headers['idempotency-replayed']).toBe('true');
    });

    it('422 when an Idempotency-Key is reused with a different body', async () => {
      const key = `e2e-conflict-${Date.now()}`;
      await request(app.getHttpServer())
        .post(`/api/v1/comments/${parentId}/replies`)
        .set('Idempotency-Key', key)
        .send({ body: 'first body' })
        .expect(202);

      const conflict = await request(app.getHttpServer())
        .post(`/api/v1/comments/${parentId}/replies`)
        .set('Idempotency-Key', key)
        .send({ body: 'a different body' })
        .expect(422);
      expect(conflict.body.title).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('keeps a rate-limited reply PENDING (outbox preserved for retry)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/comments/${parentId}/replies`)
        .send({ body: 'busy platform [simulate:rate-limit]' })
        .expect(202);
      expect(res.body.status).toBe('PENDING');

      // Status is pollable via the Location URL.
      const poll = await request(app.getHttpServer()).get(res.headers.location).expect(200);
      expect(poll.body.status).toBe('PENDING');
    });

    it('marks a permanently rejected reply FAILED with a reason', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/comments/${parentId}/replies`)
        .send({ body: 'nope [simulate:rejected]' })
        .expect(202);
      expect(res.body.status).toBe('FAILED');
      expect(res.body.failureReason).toContain('rejected');
    });

    it('enforces per-platform depth limits (Instagram: replies to top-level only)', async () => {
      const ig = await request(app.getHttpServer())
        .get('/api/v1/posts/post_published_1/comments?platform=INSTAGRAM')
        .expect(200);
      const igReply = ig.body.data.find((c: { replies: unknown[] }) => c.replies.length > 0)
        .replies[0];

      const res = await request(app.getHttpServer())
        .post(`/api/v1/comments/${igReply.id}/replies`)
        .send({ body: 'reply to a reply' })
        .expect(422);
      expect(res.body.title).toBe('REPLY_DEPTH_EXCEEDED');
    });

    it('validates the body (400 on empty / unknown fields)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/comments/${parentId}/replies`)
        .send({ body: '' })
        .expect(400);
      await request(app.getHttpServer())
        .post(`/api/v1/comments/${parentId}/replies`)
        .send({ body: 'ok', hack: true })
        .expect(400);
    });

    it('404 for an unknown parent comment', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/comments/ghost/replies')
        .send({ body: 'hello?' })
        .expect(404);
    });
  });
});
