import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Comment, CommentSource, CommentStatus, Platform } from '@prisma/client';

export class CommentAuthorDto {
  @ApiPropertyOptional({ description: "Platform's ID for the author", nullable: true })
  externalId!: string | null;

  @ApiProperty()
  name!: string;
}

export class CommentResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: Platform })
  platform!: Platform;

  @ApiProperty()
  platformPostId!: string;

  @ApiPropertyOptional({ nullable: true, description: "Platform's native comment ID" })
  externalCommentId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  parentCommentId!: string | null;

  @ApiProperty({ description: '0 = top-level comment' })
  depth!: number;

  @ApiProperty({ type: CommentAuthorDto })
  author!: CommentAuthorDto;

  @ApiProperty()
  body!: string;

  @ApiProperty({ enum: CommentSource })
  source!: CommentSource;

  @ApiProperty({
    enum: CommentStatus,
    description: 'SYNCED = mirrored from platform; PENDING/SENT/FAILED = local reply lifecycle',
  })
  status!: CommentStatus;

  @ApiPropertyOptional({ nullable: true })
  failureReason!: string | null;

  @ApiProperty({ description: 'Chronological ordering timestamp' })
  occurredAt!: Date;

  @ApiPropertyOptional({ nullable: true, description: 'When it became visible on the platform' })
  publishedAt!: Date | null;

  @ApiPropertyOptional({ type: () => [CommentResponseDto], description: 'Nested replies' })
  replies?: CommentResponseDto[];

  static from(comment: Comment & { replies?: Comment[] }, platform: Platform): CommentResponseDto {
    const dto = new CommentResponseDto();
    dto.id = comment.id;
    dto.platform = platform;
    dto.platformPostId = comment.platformPostId;
    dto.externalCommentId = comment.externalCommentId;
    dto.parentCommentId = comment.parentCommentId;
    dto.depth = comment.depth;
    dto.author = { externalId: comment.authorExternalId, name: comment.authorName };
    dto.body = comment.body;
    dto.source = comment.source;
    dto.status = comment.status;
    dto.failureReason = comment.failureReason;
    dto.occurredAt = comment.occurredAt;
    dto.publishedAt = comment.publishedAt;
    if (comment.replies) {
      dto.replies = comment.replies.map((r) => CommentResponseDto.from(r, platform));
    }
    return dto;
  }
}

export class SyncStatusDto {
  @ApiProperty({ enum: Platform })
  platform!: Platform;

  @ApiProperty({
    enum: ['FRESH', 'CACHED', 'STALE'],
    description:
      'FRESH = fetched from the platform on this request; CACHED = within TTL; ' +
      'STALE = platform unreachable, serving last-known data',
  })
  state!: 'FRESH' | 'CACHED' | 'STALE';

  @ApiPropertyOptional({ nullable: true })
  syncedAt!: Date | null;
}

export class PageMetaDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'Pass as ?cursor= to fetch the next page; null when exhausted',
  })
  nextCursor!: string | null;

  @ApiProperty({ type: [SyncStatusDto] })
  syncStatus!: SyncStatusDto[];
}

export class CommentsPageResponseDto {
  @ApiProperty({ type: [CommentResponseDto] })
  data!: CommentResponseDto[];

  @ApiProperty({ type: PageMetaDto })
  meta!: PageMetaDto;
}
