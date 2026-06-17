import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

const repoRoot = process.cwd();

const reservePort = (): number => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('reserved'),
  });
  const port = server.port;
  server.stop(true);
  return port;
};

test('dev-anvil-stack one-shot mode deploys and exits after stopping spawned anvil', async () => {
  const port = reservePort();
  const child = spawn('bun', [
    'runtime/scripts/dev-anvil-stack.ts',
    '--spawn-anvil',
    '--port', String(port),
    '--chain-id', '31338',
    '--ticker', 'TRX',
    '--name', 'Local Tron',
    '--json-only',
  ], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => child.once('exit', code => resolve(code))),
    Bun.sleep(20_000).then(() => {
      child.kill('SIGKILL');
      throw new Error(`dev-anvil-stack did not exit within 20s\nstdout=${stdout}\nstderr=${stderr}`);
    }),
  ]);

  expect(exitCode).toBe(0);
  const jsonLine = stdout.trim().split('\n').findLast(line => line.startsWith('{'));
  if (!jsonLine) {
    throw new Error(`dev-anvil-stack did not print config JSON\nstdout=${stdout}\nstderr=${stderr}`);
  }
  const config = JSON.parse(jsonLine) as {
    chainId: number;
    ticker: string;
    contracts: Record<string, string>;
  };
  expect(config.chainId).toBe(31338);
  expect(config.ticker).toBe('TRX');
  expect(config.contracts.depository).toMatch(/^0x[0-9a-fA-F]{40}$/);
});
