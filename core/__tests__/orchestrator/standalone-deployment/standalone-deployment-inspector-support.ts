import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stopProcessGroup } from '../../../scripts/e2e/runners/process-group';
import { safeStringify } from '../../../protocol/serialization';
import { privateKey, until } from '../stack-manager-recovery/stack-manager-resume-support';
import type { Fixture } from './standalone-deployment-transactions-support';

export type DebugCut = Readonly<{ source: string; statement: string; condition?: string }>;

const connectInspector = async (url: string) => {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let id = 0;
  let onPause = (_event: any) => {};
  socket.onmessage = message => {
    const event = JSON.parse(String(message.data));
    if (event.id) {
      const waiter = pending.get(event.id);
      if (!waiter) throw new Error('INSPECTOR_UNKNOWN_RESPONSE');
      pending.delete(event.id);
      if (event.error) waiter.reject(new Error(`INSPECTOR_RPC_ERROR:${event.error.message}`));
      else waiter.resolve(event.result);
    } else if (event.method === 'Debugger.paused') onPause(event.params);
  };
  await new Promise<void>((resolveOpen, reject) => {
    socket.onopen = () => resolveOpen();
    socket.onerror = () => reject(new Error('INSPECTOR_CONNECTION_FAILED'));
  });
  const request = (method: string, params = {}): Promise<any> => new Promise((resolveRequest, reject) => {
    const sequence = ++id;
    pending.set(sequence, { resolve: resolveRequest, reject });
    socket.send(safeStringify({ id: sequence, method, params }));
  });
  return { request, onPause: (callback: (event: any) => void) => { onPause = callback; }, close: () => socket.close() };
};

export const launchInspectedDeployment = async (fixture: Fixture, name: string, cut: DebugCut) => {
  const logs = ['json', 'log'].map(extension => openSync(join(fixture.directory, `${name}.${extension}`), 'wx', 0o600));
  const child = spawn('node', ['--inspect-brk=127.0.0.1:0', resolve('node_modules/hardhat/dist/src/cli.js'),
    'xln-deploy', '--network', 'stack-manager', '--parameters', fixture.parameters,
    '--deployment-id', 'resume-usdc', '--mode', 'new', '--deployment-dir', fixture.nativeDirectory], {
    cwd: resolve('jurisdictions'), detached: true, stdio: ['ignore', logs[0]!, logs[1]!],
    env: { ...process.env, NODE_OPTIONS: '', DEPLOYER_PRIVATE_KEY: privateKey,
      XLN_JURISDICTIONS_PATH: fixture.catalog, XLN_STACK_MANAGER_RPC_URL: fixture.request.rpcUrl,
      XLN_STACK_MANAGER_CHAIN_ID: '31337' },
  });
  logs.forEach(closeSync);
  const exited = new Promise<number>((resolveExit, reject) => {
    child.once('error', reject); child.once('exit', code => resolveExit(code ?? 1));
  });
  if (!child.pid) throw new Error('INSPECTOR_CHILD_PID_MISSING');
  const pid = child.pid;
  let started = '';
  let outcome: number | undefined;
  void exited.then(code => { outcome = code; });
  const log = () => readFile(join(fixture.directory, `${name}.log`), 'utf8');
  let client: Awaited<ReturnType<typeof connectInspector>> | undefined;
  const stop = async () => {
    await stopProcessGroup({ pid, signal: 'SIGKILL', termTimeoutMs: 2_000, killTimeoutMs: 2_000,
      timeoutError: 'INSPECTOR_CHILD_GROUP_REMAINS' });
    client?.close();
  };
  try {
    started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    await until(async () => outcome !== undefined || /Debugger listening on (ws:\/\/\S+)/.test(await log()), 'inspector-start');
    if (outcome !== undefined) throw new Error(await log());
    const url = (await log()).match(/Debugger listening on (ws:\/\/\S+)/)![1]!;
    client = await connectInspector(url);
    const source = await readFile(cut.source, 'utf8');
    const lineNumber = source.split('\n').findIndex(line => line.includes(cut.statement));
    if (lineNumber < 0) throw new Error('INSPECTOR_CUT_STATEMENT_MISSING');
    await client.request('Debugger.enable');
    const breakpoint = await client.request('Debugger.setBreakpointByUrl', {
      urlRegex: resolve(cut.source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', lineNumber, condition: cut.condition || '',
    });
    let paused: any;
    let error: unknown;
    const active = client;
    client.onPause(event => {
      if (event.hitBreakpoints.includes(breakpoint.breakpointId)) paused = event;
      else void active.request('Debugger.resume').catch(cause => { error = cause; });
    });
    await client.request('Runtime.runIfWaitingForDebugger');
    const waitForCut = async () => {
      await until(async () => Boolean(paused) || outcome !== undefined || Boolean(error), 'inspector-selected-cut');
      if (error) throw error;
      if (!paused) throw new Error(`INSPECTOR_CUT_NOT_REACHED:${await log()}`);
      if (paused.callFrames[0].location.lineNumber !== lineNumber) throw new Error('INSPECTOR_CUT_LOCATION_MOVED');
      return { breakpointId: breakpoint.breakpointId, source: cut.source, line: lineNumber + 1,
        location: paused.callFrames[0].location, reason: paused.reason, pid, started };
    };
    return { pid, started, exited, outcome: () => outcome, log, stop, waitForCut };
  } catch (error) { await stop(); throw error; }
};
