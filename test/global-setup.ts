import { execSync } from 'child_process';

/**
 * Resets the dedicated e2e database (social_scheduler_test) to the current
 * Prisma schema before the suite runs. Uses `db push --force-reset` so tests
 * always start from a clean, migration-independent state.
 */
export default function globalSetup(): void {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@localhost:5432/social_scheduler_test';
  execSync('npx prisma db push --force-reset --skip-generate', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
    cwd: `${__dirname}/..`,
  });
}
