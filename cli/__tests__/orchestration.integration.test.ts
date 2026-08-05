/**
 * Full-stack CLI coverage lives in `cli/scripts/orchestration-smoke.ts`
 * (same anvil + start-server path as local-prod-smoke).
 *
 * Run: `bun run test:cli:orchestration`
 * This file stays skipped under plain `bun test cli/__tests__`.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../..');

describe('cli orchestration integration', () => {
  test(
    'drives onboard/hubs/open/pay/status against canonical orchestration stack',
    async () => {
      if (process.env['XLN_CLI_ORCH'] !== '1') return;

      const child = spawn('bun', ['cli/scripts/orchestration-smoke.ts'], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', chunk => {
        const text = chunk.toString();
        stdout += text;
        process.stdout.write(text);
      });
      child.stderr.on('data', chunk => {
        process.stderr.write(chunk.toString());
      });
      const code: number = await new Promise(resolve => {
        child.on('exit', value => resolve(value ?? 1));
      });
      expect(code).toBe(0);
      expect(stdout.includes('PASS')).toBe(true);
    },
    600_000,
  );
});
