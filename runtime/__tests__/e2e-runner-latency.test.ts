import { afterEach, expect, test } from 'bun:test';

import {
  freeE2EPorts,
  parseE2EChildPerfOutput,
  parseE2EListeningPortOutput,
  readE2EListeningPortPids,
  readE2EChildrenPerf,
  runE2ECommand,
  waitForE2EServerHealthy,
} from '../scripts/run-e2e-parallel-isolated';

const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test('server readiness exits immediately when the shard is aborted', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      timestamp: Date.now(),
      reset: { inProgress: true },
      hubMesh: { ok: false },
      marketMaker: { enabled: false, ok: false },
      custody: { enabled: false, ok: false },
      bootstrapReserves: { ok: false },
    }),
  });
  servers.push(server);
  const controller = new AbortController();
  const startedAt = performance.now();
  setTimeout(() => controller.abort(new Error('test shard abort')), 25);

  await expect(waitForE2EServerHealthy(
    `http://127.0.0.1:${server.port}`,
    10_000,
    false,
    false,
    controller.signal,
  )).rejects.toThrow('E2E_ABORTED_AFTER_FIRST_FAILURE');
  expect(performance.now() - startedAt).toBeLessThan(500);
});

test('child command distinguishes exit, timeout, and outer abort', async () => {
  const exited = await runE2ECommand(process.execPath, ['-e', 'process.exit(7)'], {});
  expect(exited).toMatchObject({ kind: 'exit', code: 7, signal: null });

  const timedOut = await runE2ECommand(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 25 },
  );
  expect(timedOut.kind).toBe('timeout');

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('test abort')), 25);
  const aborted = await runE2ECommand(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { signal: controller.signal },
  );
  expect(aborted.kind).toBe('aborted');
});

test('child performance parser maps one batched ps response by pid', () => {
  const children = [
    { name: 'api', pid: 42 },
    { name: 'vite', pid: 17 },
  ];
  expect(parseE2EChildPerfOutput(children, '17 2.5 0.3 900\n42 8.75 1.2 1200\n')).toEqual([
    { name: 'api', pid: 42, cpuPct: 8.75, memPct: 1.2, rssKb: 1200 },
    { name: 'vite', pid: 17, cpuPct: 2.5, memPct: 0.3, rssKb: 900 },
  ]);
  expect(() => parseE2EChildPerfOutput(children, '42 bad 1.2 1200\n')).toThrow(
    'E2E_PS_OUTPUT_INVALID',
  );
});

test('batched child performance reader observes multiple live processes', () => {
  const samples = readE2EChildrenPerf([
    { name: 'runner', pid: process.pid },
    { name: 'parent', pid: process.ppid },
  ]);
  expect(samples.map(sample => sample.name)).toEqual(['runner', 'parent']);
  expect(samples.every(sample => sample.pid > 0 && sample.rssKb > 0)).toBe(true);
});

test('listener parser maps one batched lsof response by port', () => {
  expect(parseE2EListeningPortOutput(
    'p42\nf9\nPTCP\nn127.0.0.1:21001\nf10\nPTCP\nn*:21002\np17\nf8\nPTCP\nn[::1]:21001\n',
  )).toEqual(new Map([
    [21001, [17, 42]],
    [21002, [42]],
  ]));
  expect(() => parseE2EListeningPortOutput('n*:21001\n')).toThrow('E2E_LSOF_OUTPUT_INVALID');
});

test('batched listener reader finds two live ports in one snapshot', () => {
  const first = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  const second = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  servers.push(first, second);
  expect(readE2EListeningPortPids([first.port, second.port])).toEqual(new Map([
    [first.port, [process.pid]],
    [second.port, [process.pid]],
  ]));
});

test('batched port cleanup refuses to signal a foreign listener', async () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response('reserved') });
  const port = reservation.port;
  reservation.stop(true);
  const child = Bun.spawn([
    process.execPath,
    '-e',
    `Bun.serve({port:${port},fetch:()=>new Response('foreign')});setInterval(()=>{},1000);`,
  ], { stdout: 'ignore', stderr: 'pipe' });
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}`)).ok) break;
      } catch {}
      await Bun.sleep(20);
    }
    expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(200);

    await expect(freeE2EPorts([port])).rejects.toThrow('E2E_PORT_OWNERSHIP_CONFLICT');
    expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(200);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
});
