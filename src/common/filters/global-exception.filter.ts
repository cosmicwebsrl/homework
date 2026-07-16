import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from '../errors/domain.errors';
import {
  PlatformApiError,
  PlatformEntityNotFoundError,
  PlatformRateLimitedError,
  PlatformRejectedError,
  PlatformUnavailableError,
} from '../../platforms/platform.errors';

/**
 * Translates every error type into an RFC 9457 "problem details" response:
 *  - DomainError      -> its declared HTTP status + stable code
 *  - PlatformApiError -> gateway-style statuses (429/502/404/422)
 *  - HttpException    -> passthrough (e.g. ValidationPipe 400s)
 *  - anything else    -> opaque 500 (no internals leaked)
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      this.problem(res, exception.httpStatus, exception.code, exception.message);
      return;
    }

    if (exception instanceof PlatformApiError) {
      const status = this.platformStatus(exception);
      this.problem(
        res,
        status,
        `PLATFORM_${exception.platform}_ERROR`,
        exception.message,
        exception.retryable,
      );
      return;
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      res.status(exception.getStatus()).json(typeof body === 'string' ? { message: body } : body);
      return;
    }

    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : `${exception}`);
    this.problem(res, HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Something went wrong');
  }

  private platformStatus(e: PlatformApiError): number {
    if (e instanceof PlatformRateLimitedError) return HttpStatus.TOO_MANY_REQUESTS;
    if (e instanceof PlatformUnavailableError) return HttpStatus.BAD_GATEWAY;
    if (e instanceof PlatformEntityNotFoundError) return HttpStatus.NOT_FOUND;
    if (e instanceof PlatformRejectedError) return HttpStatus.UNPROCESSABLE_ENTITY;
    return HttpStatus.BAD_GATEWAY;
  }

  private problem(
    res: Response,
    status: number,
    code: string,
    detail: string,
    retryable?: boolean,
  ): void {
    res.status(status).json({
      type: `https://api.example.com/problems/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      ...(retryable !== undefined && { retryable }),
    });
  }
}
