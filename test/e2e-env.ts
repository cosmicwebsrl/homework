export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@localhost:5432/social_scheduler_test';

process.env.DATABASE_URL = TEST_DATABASE_URL;
