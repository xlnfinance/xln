#!/usr/bin/env bun

const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const { buildFoundationTokenListing, foundationEntityId } = require('./foundation-hanko.cjs');
const { broadcastTronTransaction } = require('../../core/jurisdiction/adapter/operations/tron-broadcast.ts');

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
      usdtEnv: 'ETH_SEPOLIA_USDT',
      wrappedNativeAddress: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
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
      usdtAddress: TRON_NILE_USDT,
      wrappedNativeAddress: 'TYsbWxNnyTgsZaTFaue9hqpxkU3Fkco94a',
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
      usdtAddress: ETH_MAINNET_USDT,
      wrappedNativeAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
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
      usdtAddress: TRON_MAINNET_USDT,
      wrappedNativeAddress: 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR',
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

const rpcUrlFor = chain => {
  const configured = String(process.env[chain.rpcEnv] || '').trim();
  if (configured) return configured;
  if (chain.defaultRpc) return chain.defaultRpc;
  throw new Error(`${chain.rpcEnv} is required for ${chain.id}`);
};

const tronFullHostFor = chain => {
  const explicit = String(process.env[chain.fullHostEnv] || '').trim();
  if (explicit) return explicit.replace(/\/jsonrpc\/?$/i, '').replace(/\/$/, '');
  return String(chain.defaultFullHost || rpcUrlFor(chain))
    .replace(/\/jsonrpc\/?$/i, '')
    .replace(/\/$/, '');
};

const jsonRpcUrlFor = chain => {
  const rpc = rpcUrlFor(chain).replace(/\/$/, '');
  return rpc.endsWith('/jsonrpc') ? rpc : `${rpc}/jsonrpc`;
};

const tronGridHeaders = () =>
  process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {};

const tronWebConnection = chain => ({
  fullHost: tronFullHostFor(chain),
  ...(chain.defaultSolidityHost ? { solidityNode: chain.defaultSolidityHost } : {}),
  headers: tronGridHeaders(),
});

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

const evmStablecoinFor = (chain, env = process.env) => {
  const fromProfile = typeof chain.usdtAddress === 'string' ? chain.usdtAddress.trim() : '';
  const fromEnvironment = chain.usdtEnv ? String(env[chain.usdtEnv] || '').trim() : '';
  const address = fromProfile || fromEnvironment;
  if (!address) {
    if (chain.id === 'ethereum-sepolia') return { address: '', deployTestStablecoin: true };
    throw new Error(`EVM_STABLECOIN_ADDRESS_REQUIRED:${chain.id}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    throw new Error(`EVM_STABLECOIN_ADDRESS_INVALID:${chain.id}:${address}`);
  }
  return { address, deployTestStablecoin: false };
};

const preflightEvmToken = async (chain, url, token, symbol, expectedDecimals, rpcCall = rpc) => {
  const code = await rpcCall(url, 'eth_getCode', [token.address, 'latest']);
  if (typeof code !== 'string' || !/^0x[0-9a-fA-F]+$/.test(code) || code === '0x') {
    throw new Error(`EVM_${symbol}_CODE_MISSING:${chain.id}:${token.address}`);
  }
  const encodedDecimals = await rpcCall(url, 'eth_call', [
    {
      to: token.address,
      data: '0x313ce567',
    },
    'latest',
  ]);
  if (typeof encodedDecimals !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(encodedDecimals)) {
    throw new Error(`EVM_${symbol}_DECIMALS_RESPONSE_INVALID:${chain.id}:${token.address}`);
  }
  const decimals = Number(BigInt(encodedDecimals));
  if (decimals !== expectedDecimals) {
    throw new Error(`EVM_${symbol}_DECIMALS_MISMATCH:${chain.id}:expected=${expectedDecimals}:actual=${decimals}`);
  }
};

const preflightEvmStablecoin = async (chain, url, stablecoin, rpcCall = rpc) => {
  if (!stablecoin.deployTestStablecoin) await preflightEvmToken(chain, url, stablecoin, 'STABLECOIN', 6, rpcCall);
};

const preflightChain = async chain => {
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
  const stablecoin = evmStablecoinFor(chain);
  const preflight = await preflightChain(chain);
  await preflightEvmStablecoin(chain, preflight.url, stablecoin);
  const wrapped = require('ethers').getAddress(chain.wrappedNativeAddress);
  if (wrapped.toLowerCase() === stablecoin.address.toLowerCase()) throw new Error('WRAPPED_NATIVE_DUPLICATES_USDT');
  await preflightEvmToken(chain, preflight.url, { address: wrapped }, 'WETH', 18);
  if (options.dryRun) {
    return { chain, preflight, dryRun: true };
  }

  requireHexPrivateKey();
  if (!process.env[chain.rpcEnv]) throw new Error(`${chain.rpcEnv} is required for ${chain.id}`);
  run('bunx', ['hardhat', 'compile']);
  mkdirSync(deploymentsDir, { recursive: true });
  const outputPath = path.join(deploymentsDir, `${chain.id}.json`);
  run('bunx', ['hardhat', 'run', 'scripts/deploy-stack.cjs', '--network', chain.hardhatNetwork], {
    env: {
      XLN_DEPLOY_OUTPUT: outputPath,
      XLN_STABLECOIN_ADDRESS: stablecoin.address,
      XLN_WRAPPED_NATIVE_ADDRESS: wrapped,
      XLN_DEPLOY_TEST_STABLECOIN: stablecoin.deployTestStablecoin ? '1' : '0',
    },
  });
  const deployed = JSON.parse(readFileSync(outputPath, 'utf8'));
  return { chain, preflight, ...deployed };
};

const artifactPath = contractName =>
  contractName === 'WTRX'
    ? path.join(repoRoot, 'external', 'wtrx.json')
    : path.join(repoRoot, 'build-tron', 'contracts', `${contractName}.json`);

const loadTronArtifact = contractName => {
  const file = artifactPath(contractName);
  if (!existsSync(file)) {
    throw new Error(`Missing TRON artifact ${file}. Run: bun scripts/compile-tron.cjs --all`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
};

const libraryMarker = libraryName => {
  let marker = `__${libraryName}`;
  while (marker.length < 40) marker += '_';
  return marker;
};

const stripHexPrefix = value => String(value).replace(/^0x/i, '');

const tronRuntimeCodeHash = (contractName, contractInfo) => {
  // getContract().bytecode includes constructor code. Only getContractInfo's
  // runtimecode identifies the program executed after deployment.
  const runtimeCode = contractInfo.runtimecode;
  if (typeof runtimeCode !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(runtimeCode)) {
    throw new Error(`TRON_DEPLOY_RUNTIME_CODE_INVALID:${contractName}`);
  }
  return require('ethers').keccak256(`0x${runtimeCode}`);
};

const tronAddressInfo = (tronWeb, address) => {
  const raw = String(address || '').trim();
  if (!raw) throw new Error('TRON deployment returned empty address');
  const hex41 = raw.startsWith('T') ? tronWeb.address.toHex(raw) : stripHexPrefix(raw);
  const normalizedHex41 = hex41.startsWith('41') ? hex41 : `41${hex41}`;
  return {
    base58: tronWeb.address.fromHex(normalizedHex41),
    hex41: `0x${normalizedHex41}`,
    evm: `0x${normalizedHex41.slice(2)}`,
  };
};

const preflightTronToken = async (chain, tronWeb, token, symbol, reader = {}) => {
  const getContract = reader.getContract || (address => tronWeb.trx.getContract(address));
  const readDecimals =
    reader.readDecimals ||
    (address => tronWeb.transactionBuilder.triggerConstantContract(address, 'decimals()', {}, [], address));
  const contract = await getContract(token.base58);
  let contractAddress;
  try {
    contractAddress = tronAddressInfo(tronWeb, contract?.contract_address);
  } catch {
    throw new Error(`TRON_${symbol}_CONTRACT_IDENTITY_INVALID:${chain.id}:${token.base58}`);
  }
  if (contractAddress.hex41.toLowerCase() !== token.hex41.toLowerCase()) {
    throw new Error(
      `TRON_${symbol}_CONTRACT_IDENTITY_MISMATCH:${chain.id}:` +
        `expected=${token.hex41}:actual=${contractAddress.hex41}`,
    );
  }
  const bytecode = typeof contract?.bytecode === 'string' ? stripHexPrefix(contract.bytecode) : '';
  if (!/^[0-9a-fA-F]+$/.test(bytecode)) {
    throw new Error(`TRON_${symbol}_CODE_MISSING:${chain.id}:${token.base58}`);
  }
  const response = await readDecimals(token.base58);
  if (response?.result?.result !== true) {
    throw new Error(`TRON_${symbol}_DECIMALS_CALL_FAILED:${chain.id}:${token.base58}`);
  }
  const encodedDecimals = stripHexPrefix(response.constant_result?.[0] || '');
  if (response.constant_result?.length !== 1 || !/^[0-9a-fA-F]{64}$/.test(encodedDecimals)) {
    throw new Error(`TRON_${symbol}_DECIMALS_RESPONSE_INVALID:${chain.id}:${token.base58}`);
  }
  const decimals = Number(BigInt(`0x${encodedDecimals}`));
  if (decimals !== 6) {
    throw new Error(`TRON_${symbol}_DECIMALS_MISMATCH:${chain.id}:expected=6:actual=${decimals}`);
  }
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

// Build the exact deployment bytes without accessing a key or broadcasting.
// A supplied TAPOS header also makes preparation offline and reproducible;
// changing it changes the transaction id and every downstream linked address.
const prepareTronContract = async (tronWeb, contractName, parameters = [], libraries = {}, blockHeader) => {
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
  return tronWeb.transactionBuilder.createSmartContract(
    { ...options, ...(blockHeader ? { blockHeader } : {}) },
    tronWeb.defaultAddress.base58,
  );
};

const deployTronContract = async (tronWeb, contractName, parameters = [], libraries = {}, preparedTransaction) => {
  const previous = preparedTransaction ? await tronWeb.trx.getTransaction(preparedTransaction) : undefined;
  const transaction = await prepareTronContract(tronWeb, contractName, parameters, libraries, previous?.raw_data);
  if (
    preparedTransaction &&
    (transaction.txID !== preparedTransaction || transaction.raw_data_hex !== previous.raw_data_hex)
  ) {
    throw new Error(`TRON_PREPARED_DEPLOYMENT_MISMATCH:${contractName}:${preparedTransaction}`);
  }
  const signed = await tronWeb.trx.sign(transaction, tronWeb.defaultPrivateKey);
  if (!preparedTransaction) {
    const broadcast = await broadcastTronTransaction(tronWeb, signed);
    if (!broadcast?.result)
      throw new Error(`TRON_DEPLOY_BROADCAST_FAILED:${contractName}:${JSON.stringify(broadcast)}`);
    console.log(`[tron-deploy] broadcast contract=${contractName} tx=${signed.txID}`);
  }
  const receiptDeadline = Date.now() + 300_000;
  while (Date.now() < receiptDeadline) {
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
      console.log(
        `[tron-deploy] solid contract=${contractName} block=${receipt.blockNumber} energy=${receipt.receipt.energy_usage_total}`,
      );
      const deployedCode = await tronWeb.trx.getContractInfo(signed.contract_address);
      return {
        ...tronAddressInfo(tronWeb, signed.contract_address),
        deploymentBlock: receipt.blockNumber,
        transactionHash: signed.txID,
        runtimeCodeHash: tronRuntimeCodeHash(contractName, deployedCode),
      };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`TRON_DEPLOY_RECEIPT_TIMEOUT:${contractName}:${signed.txID}`);
};

const deployTron = async (chain, options) => {
  const preflight = await preflightChain(chain);
  const { TronWeb } = require('tronweb');
  const readOnlyTronWeb = new TronWeb({
    ...tronWebConnection(chain),
  });

  const rawUsdtAddress = chain.usdtAddress || (chain.usdtEnv ? process.env[chain.usdtEnv] : undefined);
  if (!rawUsdtAddress) throw new Error(`${chain.usdtEnv || `${chain.id} USDT address`} is required`);
  const usdt = tronAddressInfo(
    readOnlyTronWeb,
    typeof rawUsdtAddress === 'string' ? rawUsdtAddress : rawUsdtAddress.base58,
  );
  if (typeof rawUsdtAddress === 'object') {
    for (const field of ['base58', 'hex41', 'evm']) {
      if (String(rawUsdtAddress[field]).toLowerCase() !== String(usdt[field]).toLowerCase()) {
        throw new Error(`TRON_TOKEN_ADDRESS_MISMATCH:${chain.id}:${field}`);
      }
    }
  }
  await preflightTronToken(chain, readOnlyTronWeb, usdt, 'USDT');
  const wrapped = tronAddressInfo(readOnlyTronWeb, chain.wrappedNativeAddress);
  if (wrapped.evm.toLowerCase() === usdt.evm.toLowerCase()) throw new Error('WRAPPED_NATIVE_DUPLICATES_USDT');
  await preflightTronToken(chain, readOnlyTronWeb, wrapped, 'WTRX');
  if (options.dryRun) {
    return { chain, preflight, dryRun: true };
  }

  const privateKey = requireHexPrivateKey();
  if (!options.skipCompile) run('bun', ['scripts/compile-tron.cjs', '--all', '--quiet']);
  const tronWeb = new TronWeb({
    ...tronWebConnection(chain),
    privateKey,
  });
  const deploy = (name, parameters = [], libraries = {}) =>
    deployTronContract(tronWeb, name, parameters, libraries, options.preparedTransactions?.[name]);

  // Native TRON has no sender nonce. These distinct bytecodes have no graph
  // dependencies; wait for every solidified receipt before linking consumers.
  const [account, depositoryBounds, hashLadderRegistry, nftCustody, deltaTransformer, hankoVerifier] =
    await Promise.all(
      ['Account', 'DepositoryBounds', 'HashLadderRegistry', 'NftCustody', 'DeltaTransformer', 'HankoVerifier'].map(
        name => deploy(name),
      ),
    );
  const foundationRecipient = tronWeb.defaultAddress.base58;
  const entityProvider = await deploy('EntityProvider', [foundationRecipient], { HankoVerifier: hankoVerifier });
  const depository = await deploy('Depository', [entityProvider.base58, deltaTransformer.base58], {
    Account: account,
    DepositoryBounds: depositoryBounds,
    HashLadderRegistry: hashLadderRegistry,
    NftCustody: nftCustody,
  });
  const entityProviderArtifact = loadTronArtifact('EntityProvider');
  const entityProviderContract = await tronWeb.contract(entityProviderArtifact.abi, entityProvider.base58);
  const boundDepository = tronAddressInfo(tronWeb, await entityProviderContract.shareDepository().call());
  if (/^0x0{40}$/i.test(boundDepository.evm)) {
    await entityProviderContract.bindShareDepository(depository.base58).send({
      feeLimit: Number(process.env.TRON_FEE_LIMIT || '15000000000'),
      shouldPollResponse: true,
    });
  } else if (boundDepository.evm.toLowerCase() !== depository.evm.toLowerCase()) {
    throw new Error(`TRON_PREPARED_DEPOSITORY_BINDING_MISMATCH:${boundDepository.evm}`);
  }
  const depositoryArtifact = loadTronArtifact('Depository');
  const depositoryContract = await tronWeb.contract(depositoryArtifact.abi, depository.base58);
  // Depository.registerExternalToken is callable only by the
  // EntityProvider, so USDT is listed through
  // EntityProvider.foundationRegisterExternalToken under a Foundation Hanko
  // signed by the deployer key (the genesis 1-of-1 Foundation board). The
  // action hash binds block.chainid (TRON EVM chain id) and the EVM-form
  // EntityProvider address; abi.encode uses the EVM-form addresses.
  const { ethers: tronEthers } = require('ethers');
  const foundationNonce = BigInt(
    (await entityProviderContract.entityActionNonces(foundationEntityId(tronEthers)).call()).toString(),
  );
  const registeredTokens = {};
  for (const [index, [symbol, address]] of [
    ['USDT', usdt],
    ['WTRX', wrapped],
  ].entries()) {
    const committedNonce = BigInt(
      (await entityProviderContract.entityActionNonces(foundationEntityId(tronEthers)).call()).toString(),
    );
    if (committedNonce !== foundationNonce + BigInt(index)) throw new Error('TRON_FOUNDATION_LISTING_NONCE_MISMATCH');
    const listing = buildFoundationTokenListing(tronEthers, {
      chainId: chain.chainId,
      entityProviderAddress: entityProvider.evm,
      foundationNonce: committedNonce,
      depository: depository.evm,
      tokenType: 0,
      contractAddress: address.evm,
      externalTokenId: 0,
      privateKey,
    });
    const actionHash = await entityProviderContract
      .computeFoundationActionHash(
        await entityProviderContract.FOUNDATION_REGISTER_TOKEN().call(),
        listing.argumentsHash,
        listing.actionNonce.toString(),
      )
      .call();
    if (actionHash.toLowerCase() !== listing.actionHash.toLowerCase())
      throw new Error('TRON_FOUNDATION_ACTION_HASH_MISMATCH');
    const receipt = await entityProviderContract
      .foundationRegisterExternalToken(
        depository.base58,
        0,
        address.base58,
        0,
        listing.hankoData,
        listing.actionNonce.toString(),
      )
      .send({
        feeLimit: Number(process.env.TRON_FEE_LIMIT || '15000000000'),
        shouldPollResponse: true,
        rawResponse: true,
      });
    if (receipt.receipt?.result !== 'SUCCESS') throw new Error(`TRON_TOKEN_REGISTRATION_FAILED:${symbol}`);
    const tokenId = index + 1;
    const tokenCount = BigInt((await depositoryContract.getTokensLength().call()).toString());
    const token = await depositoryContract._tokens(tokenId).call();
    const registeredAddress = tronAddressInfo(tronWeb, token.contractAddress);
    if (
      tokenCount !== BigInt(tokenId + 1) ||
      registeredAddress.evm.toLowerCase() !== address.evm.toLowerCase() ||
      BigInt(token.tokenType.toString()) !== 0n ||
      BigInt(token.externalTokenId.toString()) !== 0n
    ) {
      throw new Error(`TRON_TOKEN_REGISTRATION_MISMATCH:${symbol}:${tokenCount}:${registeredAddress.evm}`);
    }
    const afterNonce = BigInt(
      (await entityProviderContract.entityActionNonces(foundationEntityId(tronEthers)).call()).toString(),
    );
    if (afterNonce !== listing.actionNonce) throw new Error('TRON_FOUNDATION_LISTING_NONCE_MISMATCH');
    registeredTokens[symbol] = { ...address, tokenId, decimals: 6 };
  }
  if (
    tronAddressInfo(tronWeb, await entityProviderContract.shareDepository().call()).evm.toLowerCase() !==
    depository.evm.toLowerCase()
  ) {
    throw new Error('TRON_SHARE_DEPOSITORY_BINDING_MISMATCH');
  }

  return {
    chain,
    preflight,
    network: chain.id,
    chainId: chain.chainId,
    entityProviderDeploymentBlock: entityProvider.deploymentBlock,
    contracts: {
      account: account.evm,
      depositoryBounds: depositoryBounds.evm,
      hashLadderRegistry: hashLadderRegistry.evm,
      nftCustody: nftCustody.evm,
      hankoVerifier: hankoVerifier.evm,
      entityProvider: entityProvider.evm,
      depository: depository.evm,
      deltaTransformer: deltaTransformer.evm,
    },
    tronContracts: {
      account,
      depositoryBounds,
      hashLadderRegistry,
      nftCustody,
      hankoVerifier,
      entityProvider,
      depository,
      deltaTransformer,
    },
    registeredTokens,
  };
};

const tokenConfig = (chain, registeredTokens) => {
  if (!registeredTokens?.USDT) throw new Error(`DEPLOYED_TOKEN_REGISTRY_MISSING:${chain.id}`);
  return Object.fromEntries(
    Object.entries(registeredTokens).map(([symbol, token]) => [
      symbol,
      {
        symbol,
        decimals: token.decimals,
        tokenId: token.tokenId,
        address: chain.kind === 'tron' ? token.evm : token.address,
        ...(chain.kind === 'tron' ? { tron: { base58: token.base58, hex41: token.hex41, evm: token.evm } } : {}),
      },
    ]),
  );
};

const jurisdictionEntry = result => ({
  name: result.chain.name,
  chainId: result.chain.chainId,
  rpc: result.preflight.url,
  blockTimeMs: result.chain.kind === 'tron' ? 3000 : 12000,
  entityProviderDeploymentBlock: result.entityProviderDeploymentBlock,
  // Runtime binds the four entry points. Linked library
  // addresses and receipts remain in evmContracts/tronContracts, not its schema.
  contracts: {
    account: result.contracts.account,
    entityProvider: result.contracts.entityProvider,
    depository: result.contracts.depository,
    deltaTransformer: result.contracts.deltaTransformer,
  },
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
      ...Object.fromEntries(results.map(result => [result.chain.id, jurisdictionEntry(result)])),
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

const readJsonIfPresent = file => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);

const assertFreshDeploymentTargets = (profileName, chains, options) => {
  if (options.dryRun || options.replace) return;
  const configured = readJsonIfPresent(jurisdictionsPath)?.jurisdictions || {};
  const recorded = readJsonIfPresent(path.join(deploymentsDir, `${profileName}.json`))?.jurisdictions || {};
  const existing = chains.map(chain => chain.id).filter(id => configured[id] || recorded[id]);
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
    const result = chain.kind === 'tron' ? await deployTron(chain, options) : await deployEvm(chain, options);
    results.push(result);
    console.log(`[deploy-chains] ${chain.id} ${options.dryRun ? 'dry-run ok' : 'deployed'}`);
    if (!options.dryRun) {
      // A multi-chain broadcast cannot be transactionally atomic. Persist each
      // completed immutable graph before touching the next chain so a process
      // crash never turns a paid deployment into an unknown target that gets
      // redeployed by accident. Jurisdiction activation still happens only
      // after the whole selected matrix succeeds below.
      writeDeploymentOutputs(options.profile, [result], false);
    }
  }

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          profile: options.profile,
          dryRun: true,
          chains: results.map(result => ({
            id: result.chain.id,
            chainId: result.preflight.chainId,
            rpc: result.preflight.url,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  writeDeploymentOutputs(options.profile, results, options.writeJurisdictions);
};

if (require.main === module) {
  main().catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  jurisdictionEntry,
  deployTron,
  prepareTronContract,
  deployTronContract,
  tronRuntimeCodeHash,
  evmStablecoinFor,
  preflightEvmStablecoin,
  preflightTronToken,
  profiles,
};
