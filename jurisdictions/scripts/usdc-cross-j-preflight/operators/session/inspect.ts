import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveSignerAddressSync } from '../../../../../core/account/crypto';
import { getJurisdictionIdentityRef } from '../../../../../core/jurisdiction/machine/jurisdiction-runtime';
import { loadJurisdictions } from '../../../../../core/jurisdiction/adapter/kernel/jurisdiction-loader';
import { getLiveJAdapter } from '../../../../../core/runtime/j-submit/live-jadapters';
import { resolveMeshJurisdictionRpcBindings } from '../../../../../core/orchestrator/mesh/mesh-jurisdictions';
import { requireBoundaryRecord } from '../../../../../core/protocol/boundary-validation';
import { safeStringify } from '../../../../../core/protocol/serialization';
import { runtimeProof } from '../../../../../core/scenarios/usdc-poc/recovery/evidence';
import { closeUser } from '../../../../../core/scenarios/usdc-poc/user';
import { verifyPersistedFrameState } from '../../../../../core/storage/recovery/verify';
import { readExistingIdentities, readVaultSeed } from '../../identities';
import { type Role, roles } from './config';
import type { RuntimeReplica } from '../../../../../core/runtime/types';

export const assertRestoredSession = async (env: RuntimeReplica, directory: string, role: Role): Promise<void> => {
  const identity = readExistingIdentities(directory).find(value => value.role === role)!;
  const expected = new Set(identity.chains.map(chain => chain.entityId.toLowerCase()));
  const actual = new Set([...env.state.eReplicas.values()].map(replica => replica.entityId.toLowerCase()));
  if (actual.size !== expected.size || [...actual].some(id => !expected.has(id)))
    throw new Error(`USDC_SESSION_ENTITY_IDENTITY_MISMATCH:${role}`);
  const catalog = Object.values(loadJurisdictions().jurisdictions);
  if (env.state.jReplicas.size !== 2 || catalog.length !== 2) throw new Error('USDC_SESSION_JURISDICTIONS_MISMATCH');
  for (const [name, replica] of env.state.jReplicas) {
    const selected = catalog.find(chain => chain.name === name);
    if (
      !selected ||
      getJurisdictionIdentityRef(replica) !==
        getJurisdictionIdentityRef({
          chainId: selected.chainId,
          depositoryAddress: selected.contracts.depository,
        })
    )
      throw new Error(`USDC_SESSION_STACK_MISMATCH:${name}`);
    if (
      replica.blockTimeMs !== selected.blockTimeMs ||
      replica.entityProviderDeploymentBlock !== selected.entityProviderDeploymentBlock
    )
      throw new Error(`USDC_SESSION_CHAIN_CONFIGURATION_MISMATCH:${name}`);
    if (!replica.contracts) throw new Error(`USDC_SESSION_CONTRACTS_MISSING:${name}`);
    for (const key of ['account', 'entityProvider', 'deltaTransformer', 'depository'] as const) {
      const actualAddress = replica.contracts[key];
      if (!actualAddress || actualAddress.toLowerCase() !== selected.contracts[key]?.toLowerCase())
        throw new Error(`USDC_SESSION_CONTRACT_MISMATCH:${name}:${key}`);
    }
    const adapter = getLiveJAdapter(env, name);
    if (!adapter) throw new Error(`USDC_SESSION_ADAPTER_MISSING:${name}`);
    const configured = requireBoundaryRecord(selected.tokens, 'USDC_SESSION_TOKEN_REGISTRY_REQUIRED');
    const token = requireBoundaryRecord(configured['USDC'], 'USDC_SESSION_USDC_REQUIRED');
    const registry = await adapter.getTokenRegistry();
    if (
      Object.keys(configured).length !== 1 ||
      registry.length !== 1 ||
      token['tokenId'] !== 1 ||
      token['decimals'] !== 6 ||
      registry[0]!.tokenId !== 1 ||
      registry[0]!.decimals !== 6 ||
      registry[0]!.symbol !== 'USDC' ||
      registry[0]!.address.toLowerCase() !== String(token['address']).toLowerCase()
    )
      throw new Error(`USDC_SESSION_TOKEN_MISMATCH:${name}`);
  }
};

if (import.meta.main) {
  const [directory, role, output] = process.argv.slice(2);
  if (!directory || !roles.some(value => value === role) || !output)
    throw new Error('USDC_SESSION_INSPECT_INPUT_INVALID');
  const selectedRole = roles.find(value => value === role)!;
  const seed = readVaultSeed(join(directory, selectedRole));
  const identities = readExistingIdentities(directory).find(value => value.role === selectedRole)!;
  const { main, readPersistedStorageFrameRecord } = await import('../../../../../core/runtime');
  const env = await main(seed, {
    requireRestore: true,
    localSigners: identities.chains.map(chain => ({
      label: 'signerLabel' in chain ? chain.signerLabel! : String(Number(chain.signerIndex) + 1),
    })),
    trustedJurisdictionRpcBindings: resolveMeshJurisdictionRpcBindings(`${process.env['POC_API_BASE']}/rpc`, value =>
      new URL(value, process.env['POC_API_BASE']).toString(),
    ),
  });
  try {
    if (env.runtimeId?.toLowerCase() !== deriveSignerAddressSync(seed, '1').toLowerCase())
      throw new Error('USDC_SESSION_RUNTIME_IDENTITY_MISMATCH');
    await assertRestoredSession(env, directory, selectedRole);
    const frame = await readPersistedStorageFrameRecord(env, env.state.height);
    if (!frame || !verifyPersistedFrameState(env, frame).ok) throw new Error('USDC_SESSION_RESTORED_STATE_MISMATCH');
    writeFileSync(
      output,
      safeStringify(
        {
          ...runtimeProof({ env }),
          reserves: [...env.state.eReplicas.values()].map(replica => ({
            entityId: replica.entityId,
            reserves: [...replica.state.reserves],
          })),
          livePulls: [...env.state.eReplicas.values()].reduce(
            (total, replica) =>
              total +
              [...replica.state.accounts.values()].reduce(
                (count, account) => count + (account.state.pulls?.size ?? 0),
                0,
              ),
            0,
          ),
          committedOffers: [...env.state.eReplicas.values()].reduce(
            (total, replica) =>
              total +
              [...replica.state.accounts.values()].reduce((count, account) => count + account.state.swapOffers.size, 0),
            0,
          ),
          configuration: process.env['XLN_JURISDICTIONS_PATH'],
        },
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
  } finally {
    await closeUser({ env });
  }
}
