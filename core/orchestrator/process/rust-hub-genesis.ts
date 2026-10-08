import { deriveManagedEntityIdentity } from '../daemon-control';
import { assertRustEngineSingleSignerBoard } from './hub-engine-plan';
import { canonicalEntitySeed } from '../../runtime/registration/entity-creation';
import { deriveEntityEncryptionPrivateKey } from '../../runtime/registration/entity-creation/crypto';
import { deriveEntityEncryptionPublicKey } from '../../entity/auth/crypto';
import { requireBoundaryRecord } from '../../protocol/boundary-validation';
import { parseShardJurisdictions, requirePersistedTokenRegistry } from '../j-select/jurisdictions';

type RustHubGenesisInput = Readonly<{
  name: string;
  runtimeId: string;
  seed: string;
  signerLabel: string;
  jurisdictionsJson: string;
  rpcUrls: Readonly<Record<number, string>>;
  minFrameDelayMs: number;
  primaryJurisdictionOnly?: boolean;
}>;

const requireSafePositive = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(code);
  return Number(value);
};

const requireAddress = (value: unknown, code: string): string => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
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

export const buildRustHubGenesisConfig = (input: RustHubGenesisInput): Record<string, unknown> => {
  const name = input.name.trim();
  if (!name || new TextEncoder().encode(name).byteLength > 256) {
    throw new Error('RUST_HUB_GENESIS_NAME_INVALID');
  }
  const runtimeId = input.runtimeId.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(runtimeId)) throw new Error('RUST_HUB_GENESIS_RUNTIME_ID_INVALID');
  if (!Number.isSafeInteger(input.minFrameDelayMs) || input.minFrameDelayMs < 0) {
    throw new Error('RUST_HUB_GENESIS_FRAME_DELAY_INVALID');
  }
  const payload = parseShardJurisdictions(input.jurisdictionsJson, 'RUST_HUB_GENESIS_JURISDICTIONS');
  const configured = Object.entries(payload.jurisdictions ?? {}).filter(
    ([, value]) =>
      String(value['status'] || 'active')
        .trim()
        .toLowerCase() !== 'pending',
  );
  const primary = configured.find(([, value]) => value['primary'] === true) ?? configured[0];
  if (!primary) throw new Error('RUST_HUB_GENESIS_PRIMARY_JURISDICTION_MISSING');

  const selected = input.primaryJurisdictionOnly ? [primary] : configured;
  const jReplicas = selected.map(([key, value], index) => {
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
    return [
      name,
      {
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
        ...(value.mode === 'tron' ? { watcherReceiptCommitment: 'tron-rpc-attested' } : {}),
      },
    ] as const;
  });
  const [primaryKey, primaryValue] = primary;
  const primaryName = String(primaryValue.name || primaryKey).trim();
  const custodySeed = Buffer.from(canonicalEntitySeed(input.seed).slice(2), 'hex');
  // Match the TS owner selection: a primary-only H1 must not create an extra
  // sovereign Entity whose quote authority and bootstrap peers were excluded.
  const owned = [primary, ...selected.filter(([key]) => key !== primaryKey)];
  const entities = owned.map(([key, value]) => {
    const jurisdictionName = String(value.name || key).trim();
    const signerLabel = key === primaryKey ? input.signerLabel : `${input.signerLabel}:${jurisdictionName}`;
    const identity = deriveManagedEntityIdentity({ name, seed: input.seed, signerLabel });
    assertRustEngineSingleSignerBoard(identity.consensusConfig, `${name}:${signerLabel}`);
    const privateKey = deriveEntityEncryptionPrivateKey(custodySeed, identity.entityId);
    const contracts = requireBoundaryRecord(value.contracts, `RUST_HUB_GENESIS_CONTRACTS:${key}`);
    return {
      signerLabel,
      entityAuthorityJurisdiction: {
        name: jurisdictionName,
        address: resolveRpcUrl(value.rpc, input.rpcUrls),
        chainId: requireSafePositive(value.chainId, `RUST_HUB_GENESIS_CHAIN_ID:${key}`),
        depositoryAddress: requireAddress(contracts['depository'], `RUST_HUB_GENESIS_DEPOSITORY:${key}`),
        entityProviderAddress: requireAddress(contracts['entityProvider'], `RUST_HUB_GENESIS_ENTITY_PROVIDER:${key}`),
        blockTimeMs: requireSafePositive(value['blockTimeMs'], `RUST_HUB_GENESIS_BLOCK_TIME:${key}`),
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
      entityEncryptionPublicKey: deriveEntityEncryptionPublicKey(privateKey, identity.entityId),
      htlcRoutingFeePpm: 1,
      htlcRoutingBaseFee: '0',
    };
  });
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
    entities,
  };
};
