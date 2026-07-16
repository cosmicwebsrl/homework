import { Module } from '@nestjs/common';
import { SOCIAL_PLATFORM_ADAPTERS } from './platform-adapter.interface';
import { PlatformAdapterRegistry } from './platform-adapter.registry';
import { FacebookAdapter } from './adapters/facebook.adapter';
import { LinkedInAdapter } from './adapters/linkedin.adapter';
import { InstagramAdapter } from './adapters/instagram.adapter';

/**
 * To add a platform: implement SocialPlatformAdapter, add the class here.
 * Nothing else in the codebase changes.
 */
const ADAPTER_CLASSES = [FacebookAdapter, LinkedInAdapter, InstagramAdapter];

@Module({
  providers: [
    ...ADAPTER_CLASSES,
    {
      provide: SOCIAL_PLATFORM_ADAPTERS,
      useFactory: (...adapters) => adapters,
      inject: ADAPTER_CLASSES,
    },
    PlatformAdapterRegistry,
  ],
  exports: [PlatformAdapterRegistry],
})
export class PlatformsModule {}
