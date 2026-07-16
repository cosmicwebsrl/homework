/**
 * Seed: creates the scheduler-side data that "already exists" in the real system —
 * posts and their per-platform publications. Comments are intentionally NOT seeded:
 * they are pulled from the (mock) platform adapters on first read, demonstrating
 * the sync-on-read flow end to end.
 *
 * External post IDs must match the fixtures inside the mock adapters
 * (src/platforms/adapters/*.adapter.ts).
 */
import { PrismaClient, Platform, PostStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // A post that has been published to all three platforms.
  await prisma.post.upsert({
    where: { id: 'post_published_1' },
    update: {},
    create: {
      id: 'post_published_1',
      content: 'We just launched our new product! 🚀 Check it out at example.com/launch',
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

  // A post published to a single platform.
  await prisma.post.upsert({
    where: { id: 'post_published_2' },
    update: {},
    create: {
      id: 'post_published_2',
      content: 'Behind the scenes from our engineering team 👩‍💻',
      status: PostStatus.PUBLISHED,
      platformPosts: {
        create: [
          {
            id: 'pp_li_2',
            platform: Platform.LINKEDIN,
            externalPostId: 'urn:li:share:2010',
            publishedAt: new Date('2026-07-14T14:30:00Z'),
          },
        ],
      },
    },
  });

  // A draft post — used to demonstrate the "comments only for published posts" rule.
  await prisma.post.upsert({
    where: { id: 'post_draft_1' },
    update: {},
    create: {
      id: 'post_draft_1',
      content: 'Sneak peek coming soon…',
      status: PostStatus.DRAFT,
    },
  });

  console.log('Seed complete: 2 published posts (4 platform publications), 1 draft.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
