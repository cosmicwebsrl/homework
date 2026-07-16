import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { CommentsService } from './comments.service';
import { ListCommentsQueryDto } from './dto/list-comments.query.dto';
import { CreateReplyDto } from './dto/create-reply.dto';
import { CommentResponseDto, CommentsPageResponseDto } from './dto/comment.response.dto';

@ApiTags('comments')
@Controller()
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Get('posts/:postId/comments')
  @ApiOperation({
    summary: 'List comments for a published post',
    description:
      'Aggregates comments across every platform the post was published to ' +
      '(or one platform via ?platform=). Uses a read-through cache: stale ' +
      'platforms are re-fetched, unreachable ones are served from the last ' +
      'known copy (see meta.syncStatus). Cursor-paginated over top-level ' +
      'comments; replies are nested.',
  })
  @ApiOkResponse({ type: CommentsPageResponseDto })
  @ApiNotFoundResponse({ description: 'Post unknown, or not published to the given platform' })
  listComments(
    @Param('postId') postId: string,
    @Query() query: ListCommentsQueryDto,
  ): Promise<CommentsPageResponseDto> {
    return this.commentsService.getCommentsForPost(postId, query);
  }

  @Post('comments/:commentId/replies')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Reply to a comment',
    description:
      'Persists the reply immediately (outbox) and attempts synchronous ' +
      'delivery to the platform. Responds 202 because delivery is not ' +
      'guaranteed to have completed: check `status` (SENT | PENDING | FAILED) ' +
      'or poll GET /comments/{id}. Supply an Idempotency-Key header to make ' +
      'retries safe.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Unique client-generated key; replaying it returns the original reply',
  })
  @ApiAcceptedResponse({ type: CommentResponseDto })
  @ApiNotFoundResponse({ description: 'Parent comment not found' })
  async createReply(
    @Param('commentId') commentId: string,
    @Body() dto: CreateReplyDto,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CommentResponseDto> {
    const { reply, replayed } = await this.commentsService.replyToComment(
      commentId,
      dto,
      idempotencyKey,
    );
    res.setHeader('Location', `/api/v1/comments/${reply.id}`);
    if (replayed) {
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return reply;
  }

  @Get('comments/:commentId')
  @ApiOperation({
    summary: 'Get a single comment',
    description: 'Also used to poll the delivery status of a reply (PENDING → SENT/FAILED).',
  })
  @ApiOkResponse({ type: CommentResponseDto })
  @ApiNotFoundResponse({ description: 'Comment not found' })
  getComment(@Param('commentId') commentId: string): Promise<CommentResponseDto> {
    return this.commentsService.getCommentById(commentId);
  }
}
