import { safeStringify } from '../../../protocol/serialization';
import { JsonRpcProvider, Wallet } from 'ethers';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { allocateDeploymentTestFixture } from '../../../../tools/deployment/test-evidence';
import { ERC20Mock__factory } from '../../../../jurisdictions/typechain-types/factories/ERC20Mock__factory';
import { waitForRpcReady } from '../../../scripts/operations/settlement/rpc-settlement-anvil';

export const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
type Caller = ReturnType<typeof Bun.spawn>;
type Cut = number | 'hanko-validation' | 'listing-prepared';
export const until = async (check: () => Promise<boolean>, why: string): Promise<void> => {
  const end = Date.now() + 55_000;
  while (!await check()) {
    if (Date.now() > end) throw new Error(`RESUME_TEST_TIMEOUT:${why}`);
    await Bun.sleep(25);
  }
};

const freePort = async (): Promise<number> => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = server.port!;
  await server.stop(true);
  return port;
};

export const executionPid = (callerPid: number): number => {
  const table = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,command=']);
  if (table.exitCode !== 0) throw new Error(`RESUME_PROCESS_TABLE_FAILED:${table.stderr.toString()}`);
  const rows = table.stdout.toString().split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }] : [];
  });
  const owned = new Set([callerPid]);
  while (rows.some(row => !owned.has(row.pid) && owned.has(row.parent))) {
    rows.filter(row => owned.has(row.parent)).forEach(row => owned.add(row.pid));
  }
  const matches = rows.filter(
    row =>
      owned.has(row.pid) && /^(?:\S*\/)?node\s+.*\bhardhat\b.*\b(?:xln-chain-stack|xln-deploy)\b/.test(row.command),
  );
  if (matches.length !== 1) throw new Error(`RESUME_EXECUTION_CHILD_AMBIGUOUS:caller=${callerPid}:count=${matches.length}`);
  return matches[0]!.pid;
};

const startAnvil = (directory: string, port: number) => Bun.spawn(['anvil', '--host', '127.0.0.1', '--port', String(port),
  '--chain-id', '31337', '--hardfork', 'osaka', '--block-gas-limit', '60000000', '--silent'], {
  stdout: Bun.file(join(directory, 'anvil.log')), stderr: Bun.file(join(directory, 'anvil-error.log')),
});

const prepareSigner = async (provider: JsonRpcProvider, extraNonce: number) => {
  const signer = new Wallet(privateKey, provider);
  const token = await new ERC20Mock__factory(signer).deploy('USD Coin Test', 'USDC', 6, 1_000_000n);
  await token.waitForDeployment();
  for (let i = 0; i < extraNonce; i++) await (await signer.sendTransaction({ to: signer.address, value: 0 })).wait();
  const initialNonce = Number(BigInt(await provider.send('eth_getTransactionCount', [signer.address, 'latest'])));
  return { signer, token, initialNonce };
};

type CutContext = Readonly<{ directory: string; provider: JsonRpcProvider; signer: Wallet; initialNonce: number; cut: Cut }>;
const reachedCut = async (context: CutContext, input: { method: string }, result: any): Promise<boolean> => {
  const { directory, provider, signer, initialNonce, cut } = context;
  if (cut === 'listing-prepared') return Bun.file(join(directory, 'resume-usdc/manifest.json.listing.json')).exists();
  if (cut === 'hanko-validation') return input.method === 'eth_call'
    && Number(BigInt(await provider.send('eth_getTransactionCount', [signer.address, 'latest']))) === initialNonce + 10;
  if (input.method !== 'eth_getTransactionReceipt' || result?.status !== '0x1') return false;
  const tx = await provider.getTransaction(result.transactionHash);
  return tx?.from.toLowerCase() === signer.address.toLowerCase() && tx.nonce === initialNonce + cut - 1;
};

const killOwnedExecution = async (caller: Caller | undefined, context: CutContext, input: { method: string }, result: unknown) => {
  if (!caller || caller.exitCode !== null) throw new Error('RESUME_CALLER_NOT_RUNNING');
  const pid = executionPid(caller.pid);
  await writeFile(join(context.directory, 'cut.json'), safeStringify({ cut: context.cut, pid, callerPid: caller.pid,
    method: input.method, receipt: result, initialNonce: context.initialNonce }, 2));
  if (executionPid(caller.pid) !== pid) throw new Error('RESUME_EXECUTION_CHILD_CHANGED');
  process.kill(pid, 'SIGKILL');
};

const createCutProxy = (target: string, context: CutContext, caller: () => Caller | undefined) => {
  let enabled = context.cut !== 0;
  let killed = false;
  let submissions = 0;
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const payload = await request.text();
    const input = JSON.parse(payload);
    const messages = Array.isArray(input) ? input : [input];
    submissions += messages.filter(message => ['eth_sendRawTransaction', 'eth_sendTransaction'].includes(message.method)).length;
    const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    const body = await response.text();
    const result = JSON.parse(body).result;
    if (enabled && await reachedCut(context, input, result)) {
      enabled = false;
      await killOwnedExecution(caller(), context, input, result);
      killed = true;
      return new Promise<Response>(() => {});
    }
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  } });
  return { proxy, killed: () => killed, submissions: () => submissions };
};

const createCallers = (directory: string, config: string, catalog: string, request: object, setCaller: (child: Caller) => void) => {
  const env = { ...process.env, DEPLOYER_PRIVATE_KEY: privateKey, XLN_JURISDICTIONS_PATH: catalog };
  const start = (mode: 'new' | 'resume', name: string, deploymentId = 'resume-usdc', catalogPath = catalog) => {
    const child = Bun.spawn(['bun', 'core/scripts/deployment/stack-manager.ts', '--config', config,
      '--deployment-id', deploymentId, '--mode', mode, '--evidence-dir', directory], {
      env: { ...env, XLN_JURISDICTIONS_PATH: catalogPath },
      stdout: Bun.file(join(directory, `${name}.json`)), stderr: Bun.file(join(directory, `${name}.log`)),
    });
    setCaller(child);
    return child;
  };
  const startApi = (mode: 'new' | 'resume', name: string, cut?: string, publication = 'local', overrides: object = {}) => {
    const child = Bun.spawn(['bun', 'core/__tests__/fixtures/stack-manager-resume-invocation.ts'], {
      env, stdin: 'pipe', stdout: Bun.file(join(directory, `${name}.json`)), stderr: Bun.file(join(directory, `${name}.log`)),
    });
    child.stdin.write(safeStringify({ request: { ...request, publication, ...overrides }, mode, directory, cut }));
    child.stdin.end();
    setCaller(child);
    return child;
  };
  const startNative = ({ parameters, nativeDirectory, mode, name, rpcUrl }: Readonly<{
    parameters: string; nativeDirectory: string; mode: 'new' | 'resume'; name: string; rpcUrl?: string;
  }>) => {
    const child = Bun.spawn(['bunx', 'hardhat', 'xln-deploy', '--network', 'stack-manager', '--parameters', parameters,
      '--deployment-id', 'resume-usdc', '--mode', mode, '--deployment-dir', nativeDirectory], {
      cwd: join(process.cwd(), 'jurisdictions'),
      env: { ...env, XLN_STACK_MANAGER_RPC_URL: rpcUrl || String((request as Record<string, unknown>)['rpcUrl']), XLN_STACK_MANAGER_CHAIN_ID: '31337' },
      stdout: Bun.file(join(directory, `${name}.json`)), stderr: Bun.file(join(directory, `${name}.log`)),
    });
    setCaller(child);
    return child;
  };
  return { start, startApi, startNative };
};

export const startResumeNode = async (cut: Cut, extraNonce = 0) => {
  const directory = allocateDeploymentTestFixture('case-');
  const port = await freePort();
  const target = `http://127.0.0.1:${port}`;
  const node = startAnvil(directory, port);
  const provider = new JsonRpcProvider(target, 31337, { staticNetwork: true, cacheTimeout: -1 });
  await waitForRpcReady(target, 5_000);
  const { signer, token, initialNonce } = await prepareSigner(provider, extraNonce);
  let caller: Caller | undefined;
  const { proxy, killed, submissions } = createCutProxy(target, { directory, provider, signer, initialNonce, cut }, () => caller);
  const request = { name: 'Resume USDC', key: 'resume-usdc', rpcUrl: `http://127.0.0.1:${proxy.port}`, expectedChainId: 31337,
    blockTimeMs: 250, currency: 'ETH', explorer: '', signerId: signer.address, foundationRecipient: signer.address,
    stablecoin: { kind: 'existing', address: await token.getAddress() }, publication: 'local', confirmations: 12 };
  const config = join(directory, 'request.json');
  await writeFile(config, safeStringify(request));
  const catalog = join(directory, 'jurisdictions.json');
  const callers = createCallers(directory, config, catalog, request, child => { caller = child; });
  return { directory, provider, signer, initialNonce, request, config, catalog, directRpcUrl: target, ...callers, killed, submissions,
    read: (name: string) => readFile(join(directory, name), 'utf8'),
    close: async () => { await proxy.stop(true); provider.destroy(); node.kill('SIGTERM'); await node.exited; },
  };
};
