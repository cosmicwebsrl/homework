import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

/**
 * Applies the app-wide HTTP configuration (routing prefix, versioning,
 * validation, error contract). Shared by main.ts and the e2e suite so tests
 * always run against the exact production configuration — the two cannot drift.
 */
export function configureApp(app: INestApplication): INestApplication {
  // Routes look like /api/v1/... — versioned from day one so breaking changes
  // can ship as /api/v2 without disturbing existing consumers.
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties
      transform: true, // coerce query strings into typed DTOs
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  return app;
}
