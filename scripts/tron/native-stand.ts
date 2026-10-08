import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { TronWeb } from 'tronweb';
import { safeStringify } from '../../core/protocol/serialization';
import { readStandLockHolder, standLockCapacity, standLockRoot } from '../../tools/stand-lock';
const standToken = process.env.XLN_STAND_LOCK_TOKEN;
if (!standToken || !Array.from({ length: standLockCapacity() }, (_, slot) =>
  readStandLockHolder(standLockRoot(), slot)).some(holder => holder?.token === standToken))
  throw new Error('NATIVE_TRON_REQUIRES_STAND_LOCK');
const root = resolve(import.meta.dir, '../..');
const arguments_ = process.argv.slice(2);
const commandIndex = arguments_.indexOf('--');
const standArguments = commandIndex < 0 ? arguments_ : arguments_.slice(0, commandIndex);
const childCommand = commandIndex < 0 ? [] : arguments_.slice(commandIndex + 1);
if (commandIndex >= 0 && childCommand.length === 0) throw new Error('NATIVE_TRON_CHILD_COMMAND_MISSING');
const cache = join(homedir(), '.cache/xln/tron/4.8.2.1');
const data = resolve(process.env['XLN_TRON_STAND_PATH'] || `${root}/db/native-tron-release-20260918`);
// Propagate one absolute fixture root through every chain/runtime subprocess.
// A new proof must never reset or append to the historical financial ledger.
process.env['XLN_TRON_STAND_PATH'] = data;
const key = '1'.padStart(64, '0'); // Public disposable private-chain signer.
const address = TronWeb.address.fromPrivateKey(key);
const upstream = await Bun.file(`${cache}/config.upstream.conf`).text();
const reference = await Bun.file(`${cache}/reference.conf`).text();
const baseline = await Bun.file(`${root}/docs/evidence/tron-native-20260905/mainnet-parameters.json`).json();
const parameters = new Map(baseline.chainParameter.map(item => [item.key, item.value ?? 0]));
const features = [...reference.matchAll(/^\s+(\w+)\s*=.*#\s*(get\w+),/gm)]
  .filter(match => parameters.has(match[2]))
  .map(match => `committee.${match[1]} = ${parameters.get(match[2])}`).join('\n');
const config = `${upstream}
storage.db.engine = "ROCKSDB"
storage.db.sync = true
node.discovery.enable = false
node.discovery.persist = false
node.discovery.external.ip = "127.0.0.1"
node.p2p.version = 20260918
node.fastForward = []
seed.node.ip.list = []
node.listen.port = 19888
node.minParticipationRate = 0
node.http.fullNodePort = 19090
node.http.solidityPort = 19091
node.http.PBFTEnable = false
node.rpc.enable = false
node.rpc.minEffectiveConnection = 0
node.rpc.solidityEnable = false
node.rpc.PBFTEnable = false
node.jsonrpc.httpFullNodeEnable = true
node.jsonrpc.httpFullNodePort = 18545
block.needSyncCheck = false
vm.supportConstant = true
vm.estimateEnergy = true
genesis.block.assets = [
 { accountName="Blackhole", accountType="AssetIssue", address="TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy", balance="-9223372036854775808" },
 { accountName="xln-local-witness", accountType="AssetIssue", address="${address}", balance="90000000000000000" }
]
genesis.block.witnesses = [{address="${address}",url="http://localhost",voteCount=100000000}]
localwitness = ["${key}"]
${features}
`;
if (await Bun.file(`${data}/config.conf`).exists()) {
  if (await Bun.file(`${data}/config.conf`).text() !== config) throw new Error('NATIVE_TRON_CONFIG_CHANGED');
} else await Bun.write(`${data}/config.conf`, config);
const java = `${cache}/jdk-17.0.20.1+1/Contents/Home/bin/java`;
const node = Bun.spawn([java, '-Xms256m', '-Xmx2g', '-jar', `${cache}/FullNode-aarch64.jar`,
  '--witness', '--p2p-disable', 'true', '-c', `${data}/config.conf`, '-d', `${data}/ledger`], {
  cwd: data, stdout: Bun.file(`${data}/node.stdout.log`), stderr: Bun.file(`${data}/node.stderr.log`),
});
let exited = false;
void node.exited.then(() => { exited = true; });
try {
  const startedAt = Date.now();
  const deadline = Date.now() + 35000;
  let latestError: unknown;
  let report;
  while (!exited && Date.now() < deadline) {
    try {
      const full = await fetch('http://127.0.0.1:19090/wallet/getnowblock', {method:'POST',signal:AbortSignal.timeout(1000)}).then(r=>r.json());
      const solid = await fetch('http://127.0.0.1:19091/walletsolidity/getnowblock', {method:'POST',signal:AbortSignal.timeout(1000)}).then(r=>r.json());
      if (full.block_header?.raw_data?.number >= 2 && solid.block_header?.raw_data?.number >= 1 &&
        full.block_header.raw_data.timestamp >= startedAt - 3000) {
        const rpc = await fetch('http://127.0.0.1:18545/jsonrpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})}).then(r=>r.json());
        if (!rpc.result || rpc.error) throw new Error('NATIVE_RPC_FAILED:' + JSON.stringify(rpc));
        report = {kind:'NATIVE_TRON_BOOT',version:'4.8.2.1-f8b05d4',head:full.block_header.raw_data.number,solid:solid.block_header.raw_data.number,chainId:rpc.result,signer:address,full,solidBlock:solid};
        break;
      }
    } catch(error) { latestError = error; }
    await Bun.sleep(250);
  }
  if (!report) throw new Error(`NATIVE_TRON_BOOT_FAILED:exit=${exited ? await node.exited : 'running'}:logs=${data}`,{cause:latestError});
  await Bun.write(`${data}/boot.json`,safeStringify(report,2));
  console.log(safeStringify(report));
  const swap = standArguments.some(arg => ['--cross-swap', '--cross-swap-resume', '--cross-swap-restore'].includes(arg));
  const automaticWithdraw = standArguments.some(arg => ['--automatic-withdraw', '--automatic-withdraw-restore'].includes(arg));
  const withdraw = automaticWithdraw || standArguments.some(arg => ['--cross-withdraw', '--cross-withdraw-restore', '--cross-withdraw-inspect', '--cross-withdraw-resume'].includes(arg));
  if (withdraw || swap || standArguments.includes('--cross-network') || standArguments.includes('--cross-network-restore') || standArguments.includes('--cross-network-resume')) {
    const child = Bun.spawn(['bun', 'scripts/tron/ethereum-stand.ts',
      ...(withdraw ? ['--withdraw'] : []),
      ...(automaticWithdraw ? ['--automatic-withdraw'] : []),
      ...(standArguments.includes('--cross-withdraw-inspect') ? ['--inspect'] : []),
      ...(swap ? ['--swap'] : []),
      ...(standArguments.includes('--cross-network-restore') || standArguments.includes('--cross-swap-restore') || standArguments.includes('--cross-withdraw-restore') || standArguments.includes('--automatic-withdraw-restore') ? ['--restore'] : []),
      ...(standArguments.includes('--cross-network-resume') || standArguments.includes('--cross-swap-resume') || standArguments.includes('--cross-withdraw-resume') ? ['--resume'] : [])], {
      cwd: root, stdout: 'inherit', stderr: 'inherit', env: process.env,
    });
    if (await child.exited !== 0) throw new Error('NATIVE_CROSS_NETWORK_FAILED');
  }
  if (standArguments.includes('--wallet-move') || standArguments.includes('--wallet-restore')) {
    const child = Bun.spawn(['bun', 'scripts/tron/wallet-move.ts',
      ...(standArguments.includes('--wallet-restore') ? ['--restore'] : [])], {
      cwd: root, stdout: 'inherit', stderr: 'inherit',
      env: { ...process.env, XLN_DB_PATH: `${data}/runtime`, XLN_JURISDICTIONS_PATH: `${data}/jurisdictions.json` },
    });
    if (await child.exited !== 0) throw new Error('NATIVE_WALLET_MOVE_FAILED');
  }
  if (standArguments.includes('--entity-finance') || standArguments.includes('--entity-restore')) {
    const child = Bun.spawn(['bun', 'scripts/tron/entity-finance.ts',
      ...(standArguments.includes('--entity-restore') ? ['--restore'] : [])], {
      cwd: root, stdout: 'inherit', stderr: 'inherit',
      env: { ...process.env, XLN_DB_PATH: `${data}/runtime`, XLN_JURISDICTIONS_PATH: `${data}/jurisdictions.json` },
    });
    if (await child.exited !== 0) throw new Error('NATIVE_ENTITY_FINANCE_FAILED');
  }
  if (standArguments.includes('--runtime-import') || standArguments.includes('--runtime-restore') || standArguments.includes('--runtime-resume-import')) {
    const graph = await Bun.file(`${data}/graph.json`).json();
    const configuration = { version: '1', lastUpdated: '2026-09-18',
      defaults: { timeout: 10000, retryAttempts: 3, gasLimit: 10000000 },
      jurisdictions: { native: { name: 'Native TVM', chainId: graph.chainId, blockTimeMs: 3000,
        rpc: graph.chain.defaultRpc, mode: 'tron', tronFullHost: graph.chain.defaultFullHost,
        tronSolidityHost: graph.chain.defaultSolidityHost, currency: 'TRX', explorer: '', status: 'active',
        entityProviderDeploymentBlock: graph.entityProviderDeploymentBlock,
        contracts: Object.fromEntries(['account', 'depository', 'entityProvider', 'deltaTransformer']
          .map(key => [key, graph.contracts[key]])),
      } } };
    const text = JSON.stringify(configuration, null, 2);
    const path = `${data}/jurisdictions.json`;
    if (await Bun.file(path).exists()) {
      if (await Bun.file(path).text() !== text) throw new Error('NATIVE_RUNTIME_CONFIGURATION_CHANGED');
    } else await Bun.write(path, text);
    const child = Bun.spawn(['bun', 'scripts/tron/runtime-import.ts',
      ...(standArguments.includes('--runtime-restore') ? ['--restore'] : []),
      ...(standArguments.includes('--runtime-resume-import') ? ['--resume-import'] : [])], {
      cwd: root, stdout: 'inherit', stderr: 'inherit',
      env: { ...process.env, XLN_DB_PATH: `${data}/runtime`, XLN_JURISDICTIONS_PATH: path },
    });
    if (await child.exited !== 0) throw new Error('NATIVE_RUNTIME_AUTHORITY_FAILED');
  }
  if (standArguments.includes('--deploy-token') || standArguments.includes('--deploy-graph') || standArguments.includes('--verify-graph') || standArguments.includes('--economic')) {
    const { deployTronContract, deployTron } = await import('../../jurisdictions/scripts/deploy-chain-matrix.cjs');
    const tronWeb = new TronWeb({fullHost:'http://127.0.0.1:19090',solidityNode:'http://127.0.0.1:19091',privateKey:key});
    const parameters = await tronWeb.trx.getChainParameters();
    await Bun.write(`${data}/parameters.json`, JSON.stringify(parameters,null,2));
    const limit = parameters.find(item=>item.key==='getMaxFeeLimit')?.value;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('NATIVE_TRON_FEE_LIMIT_MISSING');
    process.env.TRON_FEE_LIMIT = String(limit);
    const prior = await Bun.file(`${data}/token.json`).exists() ? await Bun.file(`${data}/token.json`).json() : null;
    const token = await deployTronContract(tronWeb,'ERC20Mock',['XLN Local Test USD','XLNUSD',6,'1000000000000'],{},prior?.transactionHash);
    await Bun.write(`${data}/token.json`,JSON.stringify(token,null,2));
    console.log('NATIVE_TOKEN_DEPLOYED',JSON.stringify(token));
    if (standArguments.includes('--deploy-graph') || standArguments.includes('--verify-graph') || standArguments.includes('--economic')) {
      process.env.DEPLOYER_PRIVATE_KEY = key;
      const chain = {id:'xln-native-local',name:'XLN Native Private TVM',kind:'tron',chainId:Number(BigInt(report.chainId)),
        currency:'TRX',defaultRpc:'http://127.0.0.1:18545/jsonrpc',defaultFullHost:'http://127.0.0.1:19090',
        defaultSolidityHost:'http://127.0.0.1:19091',usdtAddress:token.base58};
      const verify = standArguments.includes('--verify-graph') || standArguments.includes('--economic');
      if (!verify && await Bun.file(`${data}/graph.json`).exists()) throw new Error('NATIVE_GRAPH_ALREADY_DEPLOYED');
      const graph = verify ? await Bun.file(`${data}/graph.json`).json() : await deployTron(chain,{skipCompile:true,dryRun:false});
      if (graph.chainId !== chain.chainId) throw new Error('NATIVE_GRAPH_CHAIN_MISMATCH');
      if (!verify) await Bun.write(`${data}/graph.json`,JSON.stringify(graph,null,2));
      const { createJAdapter } = await import('../../core/jurisdiction/adapter');
      const adapter = await createJAdapter({mode:'tron',chainId:chain.chainId,rpcUrl:chain.defaultRpc,
        tronFullHost:chain.defaultFullHost,tronSolidityHost:chain.defaultSolidityHost,privateKey:key,
        fromReplica:{contracts:graph.contracts,entityProviderDeploymentBlock:graph.entityProviderDeploymentBlock}});
      try {
        const registry = await adapter.getTokenRegistry();
        if (registry.length !== 1 || registry[0].address.toLowerCase() !== token.evm.toLowerCase())
          throw new Error('NATIVE_ADAPTER_TOKEN_REGISTRY_MISMATCH');
        const result = {mode:adapter.mode,chainId:adapter.chainId,registry,solidifiedBlock:await adapter.getCurrentBlockNumber()};
        await Bun.write(`${data}/adapter.json`,safeStringify(result,2));
        console.log('NATIVE_ADAPTER_VERIFIED',safeStringify(result));
        if (standArguments.includes('--economic')) {
          const { nativeEconomicRoundtrip } = await import('./economic-roundtrip');
          await nativeEconomicRoundtrip(adapter,key,token.evm,data);
        }
      } finally { await adapter.close(); }
    }
  }
  if (childCommand.length > 0) {
    // Keep this exact real TVM node alive for a browser/operator integration
    // driver. The enclosing stand owns its process group and shutdown.
    const child = Bun.spawn(childCommand, { cwd: root, stdout: 'inherit', stderr: 'inherit', env: process.env });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`NATIVE_TRON_CHILD_FAILED:${exitCode}`);
  }
} finally {
  if (!exited) node.kill('SIGTERM');
  const killTimer = setTimeout(() => { if (!exited) node.kill('SIGKILL'); }, 15000);
  await node.exited;
  clearTimeout(killTimer);
}
