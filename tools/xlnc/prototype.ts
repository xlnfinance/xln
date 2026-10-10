import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Wallet, SigningKey, keccak256, toBeHex, toQuantity } from 'ethers';
import { createJAdapter, createXlnJsonRpcProvider } from '../../core/jurisdiction/adapter';
import { safeStringify } from '../../core/protocol/serialization';
import { signalProcessGroup, stopProcessGroup } from '../../core/scripts/e2e/runners/process-group';
import { readDeploymentEvidence } from './deployment-evidence';

// Experimental local J. Production consensus, device budgets and capital remain separate gates.
const CHAIN_ID = 391337;
const GAS_LIMIT = 6_000_000;
const NODE_INDEXES = [0, 1, 2, 3] as const;
type NodeIndex = (typeof NODE_INDEXES)[number];
const RPC_PORTS = [19451, 19452, 19453, 19454] as const;
const P2P_PORTS = [29451, 29452, 29453, 29454] as const;
const besu = process.env['XLNC_BESU_BIN'];
const rootArg = Bun.argv[2];
if (!besu || !rootArg || !process.env['JAVA_HOME']) {
  throw new Error('XLNC_PROTOTYPE_REQUIRES: XLNC_BESU_BIN, JAVA_HOME, output directory');
}
const root = resolve(rootArg);
const providers = RPC_PORTS.map(port => createXlnJsonRpcProvider(`http://127.0.0.1:${port}`, CHAIN_ID));
const children: ChildProcess[] = [];
let validatorPaths: string[] = [];
let enodes: string[] = [];
let nodeStartError: Error | undefined;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    for (const child of children) if (child?.pid) signalProcessGroup(child.pid, 'SIGKILL');
    console.error(`XLNC_INTERRUPTED:${signal}`);
    process.exit(signal === 'SIGTERM' ? 143 : 130);
  });
}

const runBesu = async (args: string[]): Promise<string> => {
  const child = Bun.spawn([besu, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`XLNC_BESU_COMMAND:${code}:${stdout}:${stderr}`);
  return stdout.trim();
};

const initialize = async (): Promise<Wallet> => {
  await mkdir(root, { recursive: true });
  if (await Bun.file(join(root, 'network/genesis.json')).exists()) {
    throw new Error('XLNC_REQUIRES_FRESH_OUTPUT_DIRECTORY');
  }
  const wallet = Wallet.createRandom();
  await Bun.write(join(root, 'wallet.key'), wallet.privateKey);
  await chmod(join(root, 'wallet.key'), 0o600);
  const config = {
    genesis: {
      config: {
        chainId: CHAIN_ID,
        londonBlock: 0,
        shanghaiTime: 0,
        cancunTime: 0,
        qbft: { blockperiodseconds: 1, epochlength: 30000, requesttimeoutseconds: 2 },
      },
      nonce: '0x0',
      timestamp: '0x0',
      gasLimit: toBeHex(GAS_LIMIT),
      difficulty: '0x1',
      baseFeePerGas: '0x3b9aca00',
      mixHash: '0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365',
      coinbase: '0x0000000000000000000000000000000000000000',
      alloc: { [wallet.address.slice(2)]: { balance: toBeHex(10n ** 24n) } },
    },
    blockchain: { nodes: { generate: true, count: NODE_INDEXES.length } },
  };
  await Bun.write(join(root, 'generator.json'), safeStringify(config));
  await runBesu([
    'operator',
    'generate-blockchain-config',
    `--config-file=${join(root, 'generator.json')}`,
    `--to=${join(root, 'network')}`,
    '--private-key-file-name=key',
  ]);
  return new Wallet(wallet.privateKey);
};

const startNode = async (index: NodeIndex): Promise<void> => {
  const name = `validator-${index + 1}`;
  await mkdir(join(root, name), { recursive: true });
  const log = await open(join(root, `${name}.log`), 'a');
  try {
    await Bun.write(join(root, name, 'static-nodes.json'), safeStringify(enodes.filter((_, i) => i !== index)));
    const args = [
      `--data-path=${join(root, name)}`,
      `--genesis-file=${join(root, 'network/genesis.json')}`,
      '--sync-mode=FULL',
      '--sync-min-peers=1',
      '--data-storage-format=FOREST',
      '--discovery-enabled=false',
      '--p2p-host=127.0.0.1',
      `--p2p-port=${P2P_PORTS[index]}`,
      '--rpc-http-enabled',
      '--rpc-http-host=127.0.0.1',
      `--rpc-http-port=${RPC_PORTS[index]}`,
      '--rpc-http-api=ETH,NET,WEB3,ADMIN,QBFT',
      '--host-allowlist=localhost,127.0.0.1',
      '--min-gas-price=0',
      '--logging=INFO',
    ];
    args.push(`--node-private-key-file=${join(root, 'network', validatorPaths[index])}`);
    const child = spawn(besu, args, { detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.on('error', error => {
      nodeStartError = error;
    });
    children[index] = child;
  } finally {
    await log.close();
  }
};

const waitFor = async (predicate: () => Promise<boolean>, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (nodeStartError) throw nodeStartError;
    const dead = children.find(child => child && (child.exitCode !== null || child.signalCode !== null));
    if (dead) throw new Error(`XLNC_NODE_EXIT:${dead.exitCode}:${dead.signalCode}:${label}`);
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`XLNC_TIMEOUT:${label}:logs=${root}`);
};

const blockIdentity = async (
  provider: (typeof providers)[number],
  height: number,
): Promise<{ hash: string; stateRoot: string }> => {
  const block: unknown = await provider.send('eth_getBlockByNumber', [toQuantity(height), false]);
  if (
    !block ||
    typeof block !== 'object' ||
    !('hash' in block) ||
    !('stateRoot' in block) ||
    typeof block.hash !== 'string' ||
    typeof block.stateRoot !== 'string'
  )
    throw new Error('XLNC_BLOCK_IDENTITY_INVALID');
  if (!('gasLimit' in block) || BigInt(String(block.gasLimit)) !== BigInt(GAS_LIMIT))
    throw new Error(`XLNC_BLOCK_GAS_LIMIT_MISMATCH:${height}`);
  return { hash: block.hash, stateRoot: block.stateRoot };
};

const waitForRpc = async (index: NodeIndex): Promise<void> => {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${RPC_PORTS[index]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: safeStringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }).catch(error => {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ECONNREFUSED' || error.code === 'ConnectionRefused')
      )
        return null;
      throw error;
    });
    if (!response) return false;
    if (!response.ok) throw new Error(`XLNC_RPC_HTTP:${response.status}`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('result' in payload) || payload.result !== toQuantity(CHAIN_ID)) {
      throw new Error('XLNC_RPC_CHAIN_MISMATCH');
    }
    return true;
  }, `rpc-${index}`);
};

const stopNode = async (index: NodeIndex): Promise<void> => {
  const child = children[index];
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    await stopProcessGroup({
      pid: child.pid,
      signal: 'SIGTERM',
      termTimeoutMs: 3000,
      killTimeoutMs: 3000,
      timeoutError: 'XLNC_NODE_STOP_TIMEOUT',
    });
  }
  delete children[index];
};
const shutdown = async (): Promise<void> => {
  await Promise.all(NODE_INDEXES.map(stopNode));
};
const verifyRoots = async (height: number, indexes: readonly NodeIndex[] = NODE_INDEXES) => {
  await waitFor(
    async () => (await Promise.all(indexes.map(i => providers[i].getBlockNumber()))).every(n => n >= height),
    'full-node-sync',
  );
  const identities = await Promise.all(indexes.map(i => blockIdentity(providers[i], height)));
  if (identities.some(value => value.hash !== identities[0].hash || value.stateRoot !== identities[0].stateRoot))
    throw new Error(`XLNC_ROOT_MISMATCH:${height}`);
  return identities[0];
};

try {
  const clientVersion = await runBesu(['--version']);
  if (!clientVersion.startsWith('besu/v25.9.0/')) throw new Error(`XLNC_CLIENT_VERSION:${clientVersion}`);
  const wallet = await initialize();
  for await (const path of new Bun.Glob('keys/*/key').scan({ cwd: join(root, 'network'), onlyFiles: true }))
    validatorPaths.push(path);
  validatorPaths.sort();
  if (validatorPaths.length !== 4) throw new Error('XLNC_REQUIRES_FOUR_VALIDATOR_KEYS');
  enodes = await Promise.all(
    validatorPaths.map(async (path, index) => {
      const key = (await Bun.file(join(root, 'network', path)).text()).trim().replace(/^0x/, '');
      return `enode://${new SigningKey(`0x${key}`).publicKey.slice(4)}@127.0.0.1:${P2P_PORTS[index]}`;
    }),
  );
  await Promise.all(NODE_INDEXES.map(startNode));
  await Promise.all(NODE_INDEXES.map(waitForRpc));
  const validators: unknown = await providers[0].send('qbft_getValidatorsByBlockNumber', ['latest']);
  if (!Array.isArray(validators) || validators.length !== 4 || new Set(validators).size !== 4)
    throw new Error('XLNC_VALIDATOR_SET_MISMATCH');
  console.log('XLNC_STAGE:four-validators-ready');
  const feeData = await providers[0].getFeeData();
  if (feeData.maxFeePerGas === null || feeData.maxPriorityFeePerGas !== 0n) {
    throw new Error('XLNC_ZERO_PRIORITY_FEE_REGRESSION_NOT_EXERCISED');
  }
  const adapter = await createJAdapter({
    mode: 'rpc',
    chainId: CHAIN_ID,
    rpcUrl: `http://127.0.0.1:${RPC_PORTS[0]}`,
    privateKey: wallet.privateKey,
  });
  try {
    await adapter.deployStack();
    if ((await adapter.depository.getTokensLength()) !== 1n) {
      throw new Error('XLNC_NON_DEV_STACK_CREATED_BOOTSTRAP_ASSETS');
    }
    const height = await providers[0].getBlockNumber();
    const identity = await verifyRoots(height);
    const deploymentReceipts = await readDeploymentEvidence(providers, height, GAS_LIMIT);
    const contracts = [];
    for (const [name, address] of Object.entries(adapter.addresses)) {
      if (!address) continue;
      const codes = await Promise.all(providers.map(provider => provider.getCode(address, height)));
      if (codes[0] === '0x' || codes.some(code => code !== codes[0])) throw new Error(`XLNC_CONTRACT_MISMATCH:${name}`);
      contracts.push({ name, address, codeHash: keccak256(codes[0]) });
    }
    console.log(`XLNC_STAGE:contracts-and-roots-verified:height=${height}`);
    await stopNode(3);
    const outageHeight = await providers[0].getBlockNumber();
    const outageTx = await wallet.connect(providers[0]).sendTransaction({ to: wallet.address, value: 1n });
    const outageReceipt = await outageTx.wait();
    if (!outageReceipt || outageReceipt.status !== 1) throw new Error('XLNC_OUTAGE_TRANSACTION_FAILED');
    await waitFor(async () => (await providers[0].getBlockNumber()) >= outageHeight + 2, 'one-validator-down');
    await verifyRoots(outageHeight + 2, [0, 1, 2]);
    console.log('XLNC_STAGE:one-validator-down-chain-progresses');
    await startNode(3);
    await waitForRpc(3);
    await verifyRoots(outageHeight + 2);
    const afterRestart = await blockIdentity(providers[3], height);
    if (afterRestart.hash !== identity.hash || afterRestart.stateRoot !== identity.stateRoot)
      throw new Error('XLNC_RESTART_ROOT_MISMATCH');
    console.log('XLNC_STAGE:restarted-validator-caught-up');
    const evidence = {
      kind: 'experimental-stateful-evm',
      clientVersion,
      chainId: CHAIN_ID,
      blockGasLimit: GAS_LIMIT,
      referenceBlockGasLimit: 60_000_000,
      reduction: 10,
      blockPeriodSeconds: 1,
      validatorCount: 4,
      validators,
      oneValidatorOutageVerified: true,
      outageTransactionHash: outageTx.hash,
      sameOperator: true,
      height,
      zeroPriorityFeeDeploymentVerified: true,
      ...identity,
      restartVerified: true,
      contracts,
      deploymentReceipts,
      unmeasured: ['phone resources', 'two-day catch-up', 'correlated exits'],
      capitalAuthorized: 0,
    };
    await Bun.write(join(root, 'evidence.json'), safeStringify(evidence, 2));
    console.log(`XLNC_PROTOTYPE_OK:${join(root, 'evidence.json')}`);
  } finally {
    await adapter.close();
    adapter.provider?.destroy();
  }
} finally {
  await shutdown();
  providers.forEach(provider => provider.destroy());
}
