import {
  PlatformRateLimitedError,
  PlatformRejectedError,
  PlatformUnavailableError,
} from '../platform.errors';
import { Platform } from '@prisma/client';

/**
 * Shared helpers for the mock adapters.
 *
 * The mocks simulate real integration concerns deterministically:
 *  - network latency,
 *  - error scenarios triggered by magic strings in the reply body
 *    (so failures are reproducible in demos and tests, not random).
 */

export async function simulateLatency(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Magic strings that trigger simulated failures — documented in the README. */
export function simulateReplyErrors(platform: Platform, body: string): void {
  if (body.includes('[simulate:rate-limit]')) {
    throw new PlatformRateLimitedError(platform);
  }
  if (body.includes('[simulate:downtime]')) {
    throw new PlatformUnavailableError(platform);
  }
  if (body.includes('[simulate:rejected]')) {
    throw new PlatformRejectedError(platform, 'content violates community guidelines');
  }
}

let replySeq = 0;
export function nextReplyId(prefix: string): string {
  replySeq += 1;
  return `${prefix}_${Date.now()}_${replySeq}`;
}
