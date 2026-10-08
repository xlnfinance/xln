import { sendRuntimeInput } from '../commands';
import { isAddress } from 'ethers';
import { isTronChainId } from '@xln/core/api/public/runtime-module';
import { getEmbeddedEnv, requireAdapter } from '../adapter';
import { getXLN } from '../xln-loader';
import { useApp } from '../store';
import { runtimeIdForSeed } from '../keys';

export type BoardMember = { name: string; weight: number };
export type FormationDraft = { name: string; jurisdiction: string; kind: 'lazy' | 'numbered'; members: BoardMember[]; threshold: number; signerId: string };

export function validateBoard(members: BoardMember[], threshold: number): void {
  if (!members.length || members.some(member => !isAddress(member.name))) throw new Error('Every signer must have a valid wallet address.');
  if (new Set(members.map(member => member.name.toLowerCase())).size !== members.length) throw new Error('Each signer must appear only once.');
  if (members.some(member => !Number.isSafeInteger(member.weight) || member.weight < 1 || member.weight > 65535)) throw new Error('Voting weights must be integers from 1 to 65535.');
  const total = members.reduce((sum, member) => sum + member.weight, 0);
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > total) throw new Error(`Approval threshold must be between 1 and ${total}.`);
}

export async function formEntity(draft: FormationDraft): Promise<{ entityId: string; imported: boolean; transactionHash?: string }> {
  validateBoard(draft.members, draft.threshold);
  const env = getEmbeddedEnv();
  if (!env) throw new Error('Create entities on the device hosting this runtime.');
  const state = useApp.getState();
  const seed = state.activeVaultId ? state.sessionSeeds[state.activeVaultId] : undefined;
  if (!seed) throw new Error('Unlock your wallet first.');
  const adapter = requireAdapter();
  if (adapter.runtimeId.toLowerCase() !== runtimeIdForSeed(seed)) throw new Error('The connected runtime does not belong to this wallet.');
  const network = env.state.jReplicas.get(draft.jurisdiction);
  if (!network) throw new Error('Choose a connected network.');
  const depository = network.contracts?.depository;
  const entityProvider = network.contracts?.entityProvider;
  if (!depository || !entityProvider) throw new Error('This network has no configured xln contracts.');
  const xln = await getXLN();
  const members = draft.members.map(member => ({ ...member, name: member.name.trim().toLowerCase() }));
  const localSignerId = members.some(member => member.name === draft.signerId.toLowerCase()) ? draft.signerId.toLowerCase() : null;
  await adapter.ensureOwnerCommandLane();
  if (draft.kind === 'numbered') {
    if (isTronChainId(Number(network.chainId))) throw new Error('Registered entities are not supported on this network.');
    const result = await adapter.registerNumberedEntities({ jurisdictionRef: draft.jurisdiction, payerSignerId: draft.signerId, entities: [{
      name: draft.name.trim(), profileName: draft.name.trim(), validators: members, threshold: BigInt(draft.threshold),
      ...(localSignerId ? { localSignerId, entitySeed: xln.canonicalEntitySeed(seed) } : { localSignerId: null, entitySeed: null }),
    }] });
    const entity = result.entities[0];
    if (!entity) throw new Error('Registration returned no entity.');
    return { entityId: entity.entityId, imported: entity.imported, transactionHash: result.transactionHash };
  }
  const jurisdiction = { name: network.name, address: depository, depositoryAddress: depository, entityProviderAddress: entityProvider };
  const entityId = xln.generateLazyEntityId(members, BigInt(draft.threshold));
  if ([...env.state.eReplicas.values()].some(replica => replica.entityId.toLowerCase() === entityId.toLowerCase())) throw new Error('This board already exists in your wallet.');
  if (!localSignerId) throw new Error('Include your signing address to create a self-issued entity in this wallet.');
  const { config } = xln.createLazyEntity(draft.name.trim(), members, BigInt(draft.threshold), jurisdiction);
  await sendRuntimeInput({ runtimeTxs: [xln.importEntity({ entityId, signerId: localSignerId, entitySeed: seed, data: { config, isProposer: config.validators[0]?.toLowerCase() === localSignerId, profileName: draft.name.trim() } })], entityInputs: [] });
  return { entityId, imported: true };
}
