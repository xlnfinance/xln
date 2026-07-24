#!/usr/bin/env bun

const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const deploymentsDir = path.join(repoRoot, 'deployments');
const jurisdictionsPath = path.join(repoRoot, 'jurisdictions.json');

const ETH_MAINNET_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const TRON_MAINNET_USDT = {
  base58: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  hex41: '0x41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
  evm: '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c',
};
const TRON_NILE_USDT = {
  base58: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
  hex41: '0x41eca9bc828a3005b9a3b909f2cc5c2a54794de05f',
  evm: '0xeca9bc828a3005b9a3b909f2cc5c2a54794de05f',
};

const profiles = {
  testnet: {
    ethereum: {
      id: 'ethereum-sepolia',
      name: 'Ethereum Sepolia',
      kind: 'evm',
      chainId: 11155111,
      hardhatNetwork: 'ethereum-sepolia',
      rpcEnv: 'ETH_SEPOLIA_RPC',
      currency: 'ETH',
      explorer: 'https://sepolia.etherscan.io',
      disputeDelayBlocks: 7_200,
      usdtEnv: 'ETH_SEPOLIA_USDT',
    },
    tron: {
      id: 'tron-nile',
      name: 'TRON Nile',
      kind: 'tron',
      chainId: 3448148188,
      rpcEnv: 'TRON_NILE_RPC',
      fullHostEnv: 'TRON_NILE_FULL_HOST',
      defaultRpc: 'https://nile.trongrid.io/jsonrpc',
      defaultFullHost: 'https://nile.trongrid.io',
      currency: 'TRX',
      explorer: 'https://nile.tronscan.org',
      disputeDelayBlocks: 28_800,
      usdtAddress: TRON_NILE_USDT,
    },
  },
  mainnet: {
    ethereum: {
      id: 'ethereum-mainnet',
      name: 'Ethereum Mainnet',
      kind: 'evm',
      chainId: 1,
      hardhatNetwork: 'ethereum-mainnet',
      rpcEnv: 'ETH_MAINNET_RPC',
      currency: 'ETH',
      explorer: 'https://etherscan.io',
      disputeDelayBlocks: 7_200,
      usdtAddress: ETH_MAINNET_USDT,
    },
    tron: {
      id: 'tron-mainnet',
      name: 'TRON Mainnet',
      kind: 'tron',
      chainId: 728126428,
      rpcEnv: 'TRON_MAINNET_RPC',
      fullHostEnv: 'TRON_MAINNET_FULL_HOST',
      defaultRpc: 'https://api.trongrid.io/jsonrpc',
      defaultFullHost: 'https://api.trongrid.io',
      currency: 'TRX',
      explorer: 'https://tronscan.org',
      disputeDelayBlocks: 28_800,
      usdtAddress: TRON_MAINNET_USDT,
    },
  },
};

const parseArgs = () => {
  const out = {
    profile: 'testnet',
    chain: 'all',
    dryRun: false,
    skipCompile: false,
    writeJurisdictions: false,
    yes: false,
    replace: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--skip-compile') out.skipCompile = true;
    else if (arg === '--write-jurisdictions') out.writeJurisdictions = true;
    else if (arg === '--yes') out.yes = true;
    else if (arg === '--replace') out.replace = true;
    else if (arg.startsWith('--profile=')) out.profile = arg.slice('--profile='.length);
    else if (arg.startsWith('--chain=')) out.chain = arg.slice('--chain='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
};

const requireHexPrivateKey = () => {
  const raw = String(process.env.DEPLOYER_PRIVATE_KEY || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw) && !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error('DEPLOYER_PRIVATE_KEY must be a 32-byte secp256k1 private key');
  }
  return raw.replace(/^0x/, '');
};

const rpcUrlFor = (chain) => {
  const configured = String(process.env[chain.rpcEnv] || '').trim();
  if (configured) return configured;
  if (chain.defaultRpc) return chain.defaultRpc;
  throw new Error(`${chain.rpcEnv} is required for ${chain.id}`);
};

const tronFullHostFor = (chain) => {
  const explicit = String(process.env[chain.fullHostEnv] || '').trim();
  if (explicit) return explicit.replace(/\/jsonrpc\/?$/i, '').replace(/\/$/, '');
  return rpcUrlFor(chain).replace(/\/jsonrpc\/?$/i, '').replace(/\/$/, '');
};

const jsonRpcUrlFor = (chain) => {
  const rpc = rpcUrlFor(chain).replace(/\/$/, '');
  return rpc.endsWith('/jsonrpc') ? rpc : `${rpc}/jsonrpc`;
};

const tronGridHeaders = () => process.env.TRONGRID_API_KEY
  ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY }
  : {};

const rpc = async (url, method, params = [], extraHeaders = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${method} failed at ${url}: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`RPC ${method} failed at ${url}: ${JSON.stringify(payload.error)}`);
  return payload.result;
};

const preflightChain = async (chain) => {
  const url = chain.kind === 'tron' ? jsonRpcUrlFor(chain) : rpcUrlFor(chain);
  const chainIdHex = await rpc(url, 'eth_chainId', [], chain.kind === 'tron' ? tronGridHeaders() : {});
  const chainId = Number(BigInt(chainIdHex));
  if (chainId !== chain.chainId) {
    throw new Error(`${chain.id} chainId mismatch: expected=${chain.chainId} actual=${chainId} url=${url}`);
  }
  return { url, chainId };
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const details = options.capture ? `\nstdout=${result.stdout}\nstderr=${result.stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}${details}`);
  }
  return result;
};

const deployEvm = async (chain, options) => {
  const preflight = await preflightChain(chain);
  if (options.dryRun) {
    return { chain, preflight, dryRun: true };
  }

  requireHexPrivateKey();
  if (!process.env[chain.rpcEnv]) throw new Error(`${chain.rpcEnv} is required for ${chain.id}`);
  run('bunx', ['--bun', 'hardhat', 'compile']);
  mkdirSync(deploymentsDir, { recursive: true });
  const outputPath = path.join(deploymentsDir, `${chain.id}.json`);
  run('bunx', ['--bun', 'hardhat', 'run', 'scripts/deploy-stack.cjs', '--network', chain.hardhatNetwork], {
    env: {
      XLN_DEPLOY_OUTPUT: outputPath,
      XLN_DISPUTE_DELAY_BLOCKS: String(chain.disputeDelayBlocks),
      XLN_STABLECOIN_ADDRESS: String(chain.usdtEnv ? process.env[chain.usdtEnv] || '' : ''),
      XLN_DEPLOY_TEST_STABLECOIN: chain.id === 'ethereum-sepolia' && !process.env[chain.usdtEnv] ? '1' : '0',
    },
  });
  const deployed = JSON.parse(readFileSync(outputPath, 'utf8'));
  return { chain, preflight, ...deployed };
};

const artifactPath = (contractName) => path.join(repoRoot, 'build-tron', 'contracts', `${contractName}.json`);

const loadTronArtifact = (contractName) => {
  const file = artifactPath(contractName);
  if (!existsSync(file)) {
    throw new Error(`Missing TRON artifact ${file}. Run: bun scripts/compile-tron.cjs --all`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
};

const libraryMarker = (libraryName) => {
  let marker = `__${libraryName}`;
  while (marker.length < 40) marker += '_';
  return marker;
};

const stripHexPrefix = (value) => String(value).replace(/^0x/i, '');

const tronAddressInfo = (tronWeb, address) => {
  const raw = String(address || '').trim();
  if (!raw) throw new Error('TRON deployment returned empty address');
  const hex41 = raw.startsWith('T')
    ? tronWeb.address.toHex(raw)
    : stripHexPrefix(raw);
  const normalizedHex41 = hex41.startsWith('41') ? hex41 : `41${hex41}`;
  return {
    base58: tronWeb.address.fromHex(normalizedHex41),
    hex41: `0x${normalizedHex41}`,
    evm: `0x${normalizedHex41.slice(2)}`,
  };
};

const patchLinkReferences = (bytecode, linkReferences, libraries) => {
  const refs = linkReferences || {};
  const patches = [];
  for (const fileRefs of Object.values(refs)) {
    for (const [libraryName, ranges] of Object.entries(fileRefs)) {
      const address = libraries[libraryName];
      if (!address) continue;
      const evmAddress = stripHexPrefix(address.evm).toLowerCase();
      for (const range of ranges) {
        patches.push({ start: range.start * 2, end: (range.start + range.length) * 2, evmAddress });
      }
    }
  }
  let linked = bytecode;
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    linked = `${linked.slice(0, patch.start)}${patch.evmAddress}${linked.slice(patch.end)}`;
  }
  return linked;
};

const linkBytecode = (artifact, libraries) => {
  let linked = stripHexPrefix(artifact.bytecode);
  linked = patchLinkReferences(linked, artifact.linkReferences, libraries);
  for (const [libraryName, address] of Object.entries(libraries)) {
    const evmAddress = stripHexPrefix(address.evm).toLowerCase();
    linked = linked.split(libraryMarker(libraryName)).join(evmAddress);
  }
  if (linked.includes('__')) throw new Error('TRON bytecode still contains unresolved library link placeholders');
  return linked;
};

const deployTronContract = async (tronWeb, contractName, parameters = [], libraries = {}) => {
  const artifact = loadTronArtifact(contractName);
  const bytecode = linkBytecode(artifact, libraries);
  const options = {
    abi: artifact.abi,
    bytecode,
    feeLimit: Number(process.env.TRON_FEE_LIMIT || '15000000000'),
    callValue: 0,
    userFeePercentage: Number(process.env.TRON_USER_FEE_PERCENTAGE || '100'),
    originEnergyLimit: Number(process.env.TRON_ORIGIN_ENERGY_LIMIT || '10000000'),
    parameters,
  };
  const transaction = await tronWeb.transactionBuilder.createSmartContract(
    options,
    tronWeb.defaultAddress.base58,
  );
  const signed = await tronWeb.trx.sign(transaction, tronWeb.defaultPrivateKey);
  const broadcast = await tronWeb.trx.sendRawTransaction(signed);
  if (!broadcast?.result) throw new Error(`TRON_DEPLOY_BROADCAST_FAILED:${contractName}:${JSON.stringify(broadcast)}`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = await tronWeb.trx.getTransactionInfo(signed.txID);
    if (Object.keys(receipt || {}).length > 0) {
      if (receipt.receipt?.result !== 'SUCCESS') {
        throw new Error(
          `TRON_DEPLOY_EXECUTION_FAILED:${contractName}:${signed.txID}:` +
          `${receipt.receipt?.result || 'UNKNOWN'}:${receipt.resMessage || ''}`,
        );
      }
      if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 1) {
        throw new Error(`TRON_DEPLOY_BLOCK_MISSING:${contractName}:${signed.txID}`);
      }
      return {
        ...tronAddressInfo(tronWeb, signed.contract_address),
        deploymentBlock: receipt.blockNumber,
        transactionHash: signed.txID,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`TRON_DEPLOY_RECEIPT_TIMEOUT:${contractName}:${signed.txID}`);
};

const deployTron = async (chain, options) => {
  const preflight = await preflightChain(chain);
  if (options.dryRun) {
    return { chain, preflight, dryRun: true };
  }

  const privateKey = requireHexPrivateKey();
  if (!options.skipCompile) run('bun', ['scripts/compile-tron.cjs', '--all', '--quiet']);
  const { TronWeb } = require('tronweb');
  const tronWeb = new TronWeb({
    fullHost: tronFullHostFor(chain),
    headers: tronGridHeaders(),
    privateKey,
  });

  const rawUsdtAddress = chain.usdtAddress || (chain.usdtEnv ? process.env[chain.usdtEnv] : undefined);
  if (!rawUsdtAddress) throw new Error(`${chain.usdtEnv || `${chain.id} USDT address`} is required`);
  const usdt = tronAddressInfo(
    tronWeb,
    typeof rawUsdtAddress === 'string' ? rawUsdtAddress : rawUsdtAddress.base58,
  );
  if (typeof rawUsdtAddress === 'object') {
    for (const field of ['base58', 'hex41', 'evm']) {
      if (String(rawUsdtAddress[field]).toLowerCase() !== String(usdt[field]).toLowerCase()) {
        throw new Error(`TRON_TOKEN_ADDRESS_MISMATCH:${chain.id}:${field}`);
      }
    }
  }

  const account = await deployTronContract(tronWeb, 'Account');
  const foundationRecipient = tronWeb.defaultAddress.base58;
  const hankoVerifier = await deployTronContract(tronWeb, 'HankoVerifier');
  const entityProvider = await deployTronContract(
    tronWeb,
    'EntityProvider',
    [foundationRecipient],
    { HankoVerifier: hankoVerifier },
  );
  const depository = await deployTronContract(
    tronWeb,
    'Depository',
    [entityProvider.base58, chain.disputeDelayBlocks],
    { Account: account },
  );
  const deltaTransformer = await deployTronContract(tronWeb, 'DeltaTransformer');
  const depositoryArtifact = loadTronArtifact('Depository');
  const depositoryContract = await tronWeb.contract(depositoryArtifact.abi, depository.base58);
  await depositoryContract.registerExternalToken(0, usdt.base58, 0).send({
    feeLimit: Number(process.env.TRON_FEE_LIMIT || '15000000000'),
    shouldPollResponse: true,
  });
  const tokenCount = BigInt((await depositoryContract.getTokensLength().call()).toString());
  const disputeDelayBlocks = Number((await depositoryContract.defaultDisputeDelay().call()).toString());
  const token = await depositoryContract._tokens(1).call();
  const registeredAddress = tronAddressInfo(tronWeb, token.contractAddress ?? token[0]);
  if (tokenCount !== 2n || registeredAddress.evm.toLowerCase() !== usdt.evm.toLowerCase()) {
    throw new Error(
      `TRON_USDT_REGISTRATION_MISMATCH:count=${tokenCount}:expected=${usdt.evm}:actual=${registeredAddress.evm}`,
    );
  }
  if (disputeDelayBlocks !== chain.disputeDelayBlocks) {
    throw new Error(
      `TRON_DISPUTE_DELAY_MISMATCH:expected=${chain.disputeDelayBlocks}:actual=${disputeDelayBlocks}`,
    );
  }

  return {
    chain,
    preflight,
    network: chain.id,
    chainId: chain.chainId,
    defaultDisputeDelayBlocks: disputeDelayBlocks,
    entityProviderDeploymentBlock: entityProvider.deploymentBlock,
    contracts: {
      account: account.evm,
      hankoVerifier: hankoVerifier.evm,
      entityProvider: entityProvider.evm,
      depository: depository.evm,
      deltaTransformer: deltaTransformer.evm,
    },
    tronContracts: {
      account,
      hankoVerifier,
      entityProvider,
      depository,
      deltaTransformer,
    },
    registeredTokens: { USDT: { ...usdt, tokenId: 1, decimals: 6 } },
  };
};

const tokenConfig = (chain, registeredTokens) => {
  if (registeredTokens?.USDT) {
    const token = registeredTokens.USDT;
    return {
      USDT: {
        symbol: 'USDT',
        decimals: token.decimals,
        tokenId: token.tokenId,
        address: token.evm || token.address,
        ...(token.base58 && token.hex41 && token.evm ? {
        tron: {
          base58: token.base58,
          hex41: token.hex41,
          evm: token.evm,
        },
        } : {}),
      },
    };
  }
  const raw = chain.usdtAddress || (chain.usdtEnv ? process.env[chain.usdtEnv] : undefined);
  if (!raw) return {};
  return {
    USDT: {
      symbol: 'USDT',
      decimals: 6,
      address: typeof raw === 'string' ? raw : raw.evm,
      ...(typeof raw === 'object' ? { tron: raw } : {}),
    },
  };
};

const jurisdictionEntry = (result) => ({
  name: result.chain.name,
  chainId: result.chain.chainId,
  rpc: result.preflight.url,
  blockTimeMs: result.chain.kind === 'tron' ? 3000 : 12000,
  defaultDisputeDelayBlocks: result.defaultDisputeDelayBlocks ?? result.chain.disputeDelayBlocks,
  entityProviderDeploymentBlock: result.entityProviderDeploymentBlock,
  contracts: result.contracts,
  explorer: result.chain.explorer,
  currency: result.chain.currency,
  // Deployment evidence never activates a jurisdiction. Promotion to active
  // is a separate reviewed config change after authority-proof gates pass.
  status: 'pending',
  description: `${result.chain.name} XLN deployment`,
  tokens: tokenConfig(result.chain, result.registeredTokens),
  ...(result.evmContracts ? { evmContracts: result.evmContracts } : {}),
  ...(result.tronContracts ? { tronContracts: result.tronContracts } : {}),
});

const writeDeploymentOutputs = (profileName, results, writeJurisdictions) => {
  mkdirSync(deploymentsDir, { recursive: true });
  const deploymentPath = path.join(deploymentsDir, `${profileName}.json`);
  const existingDeployments = readJsonIfPresent(deploymentPath)?.jurisdictions || {};
  const deployPayload = {
    profile: profileName,
    deployedAt: new Date().toISOString(),
    jurisdictions: {
      ...existingDeployments,
      ...Object.fromEntries(results.map((result) => [result.chain.id, jurisdictionEntry(result)])),
    },
  };
  writeFileSync(deploymentPath, JSON.stringify(deployPayload, null, 2));
  console.log(`[deploy-chains] wrote ${path.relative(repoRoot, deploymentPath)}`);

  if (!writeJurisdictions) return;
  const current = JSON.parse(readFileSync(jurisdictionsPath, 'utf8'));
  current.lastUpdated = deployPayload.deployedAt;
  current.jurisdictions = {
    ...(current.jurisdictions || {}),
    ...deployPayload.jurisdictions,
  };
  current.deployVersion = `chains-${profileName}-${deployPayload.deployedAt}`;
  current.networkVersion = current.deployVersion;
  writeFileSync(jurisdictionsPath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`[deploy-chains] updated ${path.relative(repoRoot, jurisdictionsPath)}`);
};

const selectChains = (profile, chainSelector) => {
  if (chainSelector === 'all') return [profile.ethereum, profile.tron];
  if (chainSelector === 'ethereum' || chainSelector === 'eth') return [profile.ethereum];
  if (chainSelector === 'tron') return [profile.tron];
  throw new Error(`Unknown --chain=${chainSelector}`);
};

const readJsonIfPresent = (file) => existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : undefined;

const assertFreshDeploymentTargets = (profileName, chains, options) => {
  if (options.dryRun || options.replace) return;
  const configured = readJsonIfPresent(jurisdictionsPath)?.jurisdictions || {};
  const recorded = readJsonIfPresent(path.join(deploymentsDir, `${profileName}.json`))?.jurisdictions || {};
  const existing = chains
    .map((chain) => chain.id)
    .filter((id) => configured[id] || recorded[id]);
  if (existing.length > 0) {
    throw new Error(
      `DEPLOYMENT_ALREADY_EXISTS:${existing.join(',')}:` +
      'refusing to broadcast replacement transactions without explicit --replace',
    );
  }
};

const main = async () => {
  const options = parseArgs();
  const profile = profiles[options.profile];
  if (!profile) throw new Error(`Unknown --profile=${options.profile}`);
  if (options.profile === 'mainnet' && !options.dryRun && !options.yes) {
    throw new Error('Mainnet deployment requires --yes');
  }

  const selected = selectChains(profile, options.chain);
  assertFreshDeploymentTargets(options.profile, selected, options);
  const results = [];
  for (const chain of selected) {
    console.log(`[deploy-chains] preflight ${chain.id}`);
    const result = chain.kind === 'tron'
      ? await deployTron(chain, options)
      : await deployEvm(chain, options);
    results.push(result);
    console.log(`[deploy-chains] ${chain.id} ${options.dryRun ? 'dry-run ok' : 'deployed'}`);
  }

  if (options.dryRun) {
    console.log(JSON.stringify({
      profile: options.profile,
      dryRun: true,
      chains: results.map((result) => ({
        id: result.chain.id,
        chainId: result.preflight.chainId,
        rpc: result.preflight.url,
      })),
    }, null, 2));
    return;
  }

  writeDeploymentOutputs(options.profile, results, options.writeJurisdictions);
};

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
