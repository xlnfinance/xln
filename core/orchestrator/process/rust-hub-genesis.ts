import {
  getSwapPairOrientation,
  getSwapPairPolicyForDimensions,
  getTokenInfo,
} from '../../account/utils';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';
import { HUB_DEFAULT_MIN_TRADE_SIZE, HUB_DEFAULT_SUPPORTED_PAIRS } from '../mesh/mesh-common';
import {
  parseShardJurisdictions,
  requirePersistedTokenRegistry,
} from '../j-select/jurisdictions';

type RustHubGenesisInput = Readonly<{
  name: string;
  runtimeId: string;
  entityEncryptionPublicKey: string;
  jurisdictionsJson: string;
  rpcUrls: Readonly<Record<number, string>>;
  minFrameDelayMs: number;
}>;

const requireSafePositive = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(code);
  return Number(value);
};

const requireAddress = (value: unknown, code: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(code);
  return normalized;
};

const resolveRpcUrl = (raw: unknown, rpcUrls: Readonly<Record<number, string>>): string => {
  const value = String(raw || '').trim();
  const match = /^\/(?:api\/)?rpc([2-8])?$/.exec(value);
  if (!match) {
    new URL(value);
    return value;
  }
  const index = match[1] ? Number(match[1]) : 1;
  const resolved = String(rpcUrls[index] || '').trim();
  if (!resolved) throw new Error(`RUST_HUB_GENESIS_RPC_MISSING:${String(index)}`);
  new URL(resolved);
  return resolved;
};

const pairPolicy = (pairId: string): readonly [string, number, number, string] => {
  const match = /^(\d+)\/(\d+)$/.exec(pairId);
  if (!match) throw new Error(`RUST_HUB_GENESIS_PAIR_INVALID:${pairId}`);
  const tokenA = Number(match[1]);
  const tokenB = Number(match[2]);
  const { baseTokenId, quoteTokenId } = getSwapPairOrientation(tokenA, tokenB);
  const policy = getSwapPairPolicyForDimensions(
    baseTokenId,
    quoteTokenId,
    getTokenInfo(baseTokenId).decimals,
    getTokenInfo(quoteTokenId).decimals,
  );
  return [pairId, policy.priceStepTicks, policy.bookBucketWidthTicks, policy.mmMidPriceTicks.toString()];
};

export const buildRustHubGenesisConfig = (input: RustHubGenesisInput): Record<string, unknown> => {
  const name = input.name.trim();
  if (!name || new TextEncoder().encode(name).byteLength > 256) {
    throw new Error('RUST_HUB_GENESIS_NAME_INVALID');
  }
  const runtimeId = input.runtimeId.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(runtimeId)) throw new Error('RUST_HUB_GENESIS_RUNTIME_ID_INVALID');
  const entityEncryptionPublicKey = input.entityEncryptionPublicKey.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(entityEncryptionPublicKey)) {
    throw new Error('RUST_HUB_GENESIS_ENTITY_KEY_INVALID');
  }
  if (!Number.isSafeInteger(input.minFrameDelayMs) || input.minFrameDelayMs < 0) {
    throw new Error('RUST_HUB_GENESIS_FRAME_DELAY_INVALID');
  }
  const payload = parseShardJurisdictions(input.jurisdictionsJson, 'RUST_HUB_GENESIS_JURISDICTIONS');
  const configured = Object.entries(payload.jurisdictions ?? {})
    .filter(([, value]) => String(value['status'] || 'active').trim().toLowerCase() !== 'pending');
  const primary = configured.find(([, value]) => value['primary'] === true) ?? configured[0];
  if (!primary) throw new Error('RUST_HUB_GENESIS_PRIMARY_JURISDICTION_MISSING');

  const jReplicas = configured.map(([key, value], index) => {
    const name = String(value.name || key).trim();
    if (!name) throw new Error(`RUST_HUB_GENESIS_JURISDICTION_NAME:${key}`);
    const chainId = requireSafePositive(value.chainId, `RUST_HUB_GENESIS_CHAIN_ID:${key}`);
    const blockTimeMs = requireSafePositive(value['blockTimeMs'], `RUST_HUB_GENESIS_BLOCK_TIME:${key}`);
    const contracts = requireBoundaryRecord(value.contracts, `RUST_HUB_GENESIS_CONTRACTS:${key}`);
    const tokenRegistry = requirePersistedTokenRegistry(
      value['tokenRegistry'],
      `RUST_HUB_GENESIS_TOKEN_REGISTRY:${key}`,
    ).map(token => ({
      ...token,
      externalTokenId: { __xlnType: 'BigInt', value: token.externalTokenId },
    }));
    return [name, {
      blockDelayMs: 300,
      blockNumber: { __xlnType: 'BigInt', value: '0' },
      blockTimeMs,
      blockReady: false,
      chainId,
      contracts: {
        account: requireAddress(contracts['account'], `RUST_HUB_GENESIS_ACCOUNT:${key}`),
        depository: requireAddress(contracts['depository'], `RUST_HUB_GENESIS_DEPOSITORY:${key}`),
        entityProvider: requireAddress(contracts['entityProvider'], `RUST_HUB_GENESIS_ENTITY_PROVIDER:${key}`),
        deltaTransformer: requireAddress(contracts['deltaTransformer'], `RUST_HUB_GENESIS_TRANSFORMER:${key}`),
      },
      entityProviderDeploymentBlock: requireSafePositive(
        value.entityProviderDeploymentBlock,
        `RUST_HUB_GENESIS_DEPLOYMENT_BLOCK:${key}`,
      ),
      lastBlockTimestamp: 0,
      mempool: [],
      name,
      position: { x: index * 160, y: index === 0 ? 0 : 600, z: index * 120 },
      rpcs: [resolveRpcUrl(value.rpc, input.rpcUrls)],
      stateRoot: null,
      tokenRegistry,
      watcherConfirmationDepth: 0,
    }] as const;
  });
  const [primaryKey, primaryValue] = primary;
  const primaryName = String(primaryValue.name || primaryKey).trim();
  const primaryContracts = requireBoundaryRecord(
    primaryValue.contracts,
    `RUST_HUB_GENESIS_CONTRACTS:${primaryKey}`,
  );
  const primaryRpc = resolveRpcUrl(primaryValue.rpc, input.rpcUrls);
  return {
    timestamp: 0,
    machine: {
      runtimeId,
      activeJurisdiction: primaryName,
      runtimeConfig: { loopIntervalMs: 0, minFrameDelayMs: input.minFrameDelayMs },
      infrastructure: {
        accountJClaimNodes: { __xlnType: 'Map', value: [] },
        certifiedBoardNodes: { __xlnType: 'Map', value: [] },
        certifiedRegistrationEvidence: { __xlnType: 'Map', value: [] },
        entityEncryptionSeeds: { __xlnType: 'Map', value: [] },
        runtimeAdapterCommandFrontiers: { __xlnType: 'Map', value: [] },
      },
      jReplicas,
    },
    entityAuthorityJurisdiction: {
      name: primaryName,
      address: primaryRpc,
      chainId: requireSafePositive(primaryValue.chainId, `RUST_HUB_GENESIS_CHAIN_ID:${primaryKey}`),
      depositoryAddress: requireAddress(
        primaryContracts['depository'],
        `RUST_HUB_GENESIS_DEPOSITORY:${primaryKey}`,
      ),
      entityProviderAddress: requireAddress(
        primaryContracts['entityProvider'],
        `RUST_HUB_GENESIS_ENTITY_PROVIDER:${primaryKey}`,
      ),
      blockTimeMs: requireSafePositive(
        primaryValue['blockTimeMs'],
        `RUST_HUB_GENESIS_BLOCK_TIME:${primaryKey}`,
      ),
    },
    entityContextPolicy: {
      minimumTradeSize: { __xlnType: 'BigInt', value: HUB_DEFAULT_MIN_TRADE_SIZE.toString() },
      swapTakerFeeBps: 1,
      jurisdictionId: primaryName,
      pairPolicies: HUB_DEFAULT_SUPPORTED_PAIRS.map(pairPolicy),
    },
    entityProfile: {
      name,
      isHub: true,
      entityKind: 'protocol',
      sectors: ['finance', 'infrastructure'],
      avatar: '',
      bio: '',
      website: '',
    },
    entityEncryptionPublicKey,
    htlcRoutingFeePpm: 1,
    htlcRoutingBaseFee: '0',
  };
};
