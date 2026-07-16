-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('FACEBOOK', 'LINKEDIN', 'INSTAGRAM');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "CommentSource" AS ENUM ('PLATFORM', 'LOCAL');

-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('SYNCED', 'PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_posts" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalPostId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "commentsSyncedAt" TIMESTAMP(3),

    CONSTRAINT "platform_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "platformPostId" TEXT NOT NULL,
    "externalCommentId" TEXT,
    "parentCommentId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "authorExternalId" TEXT,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source" "CommentSource" NOT NULL,
    "status" "CommentStatus" NOT NULL,
    "failureReason" TEXT,
    "idempotencyKey" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_posts_postId_platform_key" ON "platform_posts"("postId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "platform_posts_platform_externalPostId_key" ON "platform_posts"("platform", "externalPostId");

-- CreateIndex
CREATE UNIQUE INDEX "comments_idempotencyKey_key" ON "comments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "comments_platformPostId_occurredAt_id_idx" ON "comments"("platformPostId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "comments_parentCommentId_idx" ON "comments"("parentCommentId");

-- CreateIndex
CREATE UNIQUE INDEX "comments_platformPostId_externalCommentId_key" ON "comments"("platformPostId", "externalCommentId");

-- AddForeignKey
ALTER TABLE "platform_posts" ADD CONSTRAINT "platform_posts_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_platformPostId_fkey" FOREIGN KEY ("platformPostId") REFERENCES "platform_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentCommentId_fkey" FOREIGN KEY ("parentCommentId") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
