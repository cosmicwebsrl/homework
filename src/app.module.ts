import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { PlatformsModule } from './platforms/platforms.module';
import { CommentsModule } from './comments/comments.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    PlatformsModule,
    CommentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
