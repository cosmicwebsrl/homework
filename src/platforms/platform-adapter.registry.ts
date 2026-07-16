import { Inject, Injectable } from '@nestjs/common';
import { Platform } from '@prisma/client';
import {
  SOCIAL_PLATFORM_ADAPTERS,
  SocialPlatformAdapter,
} from './platform-adapter.interface';
import { UnsupportedPlatformError } from '../common/errors/domain.errors';

/**
 * Resolves the correct adapter for a platform at runtime.
 * Adapters self-describe their platform, so registration is automatic —
 * the registry never needs editing when a platform is added.
 */
@Injectable()
export class PlatformAdapterRegistry {
  private readonly adapters: ReadonlyMap<Platform, SocialPlatformAdapter>;

  constructor(@Inject(SOCIAL_PLATFORM_ADAPTERS) adapters: SocialPlatformAdapter[]) {
    this.adapters = new Map(adapters.map((a) => [a.platform, a]));
  }

  getAdapter(platform: Platform): SocialPlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new UnsupportedPlatformError(platform);
    }
    return adapter;
  }

  get supportedPlatforms(): Platform[] {
    return [...this.adapters.keys()];
  }
}
