import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = configureApp(await NestFactory.create(AppModule));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Social Scheduler — Comments API')
    .setDescription(
      'Comment retrieval and replies for posts published across multiple social platforms.',
    )
    .setVersion('1.0')
    .addTag('comments')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API ready on http://localhost:${port}/api/v1 — Swagger UI at /docs`);
}

void bootstrap();
