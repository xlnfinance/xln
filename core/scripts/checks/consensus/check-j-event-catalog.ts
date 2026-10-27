import {
  Account__factory,
  Depository__factory,
  EntityProvider__factory,
} from '../../../../jurisdictions/typechain-types';
import {
  DEPOSITORY_J_EVENTS,
  ENTITY_PROVIDER_J_EVENTS,
} from '../../../jurisdiction/machine/event-catalog';

type EventPolicy = {
  consensus: readonly string[];
  telemetry: readonly string[];
};

const abiEventNames = (factory: { createInterface(): { fragments: readonly unknown[] } }): string[] =>
  factory.createInterface().fragments
    .flatMap(fragment => {
      const candidate = fragment as { type?: string; name?: string };
      return candidate.type === 'event' && candidate.name ? [candidate.name] : [];
    })
    .sort();

const assertExactPolicy = (
  contract: string,
  abiNames: readonly string[],
  policy: EventPolicy,
): void => {
  const classified = [...policy.consensus, ...policy.telemetry];
  const duplicates = classified.filter((name, index) => classified.indexOf(name) !== index);
  const missing = abiNames.filter(name => !classified.includes(name));
  const stale = classified.filter(name => !abiNames.includes(name));
  if (duplicates.length || missing.length || stale.length) {
    throw new Error(
      `J_EVENT_CATALOG_MISMATCH:${contract}` +
      `:duplicates=${duplicates.join(',') || 'none'}` +
      `:missing=${missing.join(',') || 'none'}` +
      `:stale=${stale.join(',') || 'none'}`,
    );
  }
};

assertExactPolicy(
  'Depository',
  abiEventNames(Depository__factory),
  DEPOSITORY_J_EVENTS,
);
assertExactPolicy(
  'EntityProvider',
  abiEventNames(EntityProvider__factory),
  ENTITY_PROVIDER_J_EVENTS,
);
const depository = Depository__factory.createInterface();
const account = Account__factory.createInterface();
for (const name of ['DisputeStarted', 'CounterDisputeRegistered', 'DisputeFinalized'] as const) {
  const event = depository.getEvent(name);
  if (event.format('full') !== account.getEvent(name).format('full')
    || event.inputs.find(input => input.name === 'proofbody')?.type !== 'bytes') {
    throw new Error(`J_DISPUTE_EVENT_ABI_MISMATCH:${name}`);
  }
}
const sidecar = depository.getEvent('DisputeFinalized').inputs.find(input => input.name === 'finalization');
if (sidecar?.components?.map(input => `${input.name}:${input.type}`).join(',') !==
  'initialProofbodyHash:bytes32,finalNonce:uint256,proposerIsLeft:bool,startedByLeft:bool,starterArgumentsHash:bytes32,otherArguments:bytes,sig:bytes') {
  throw new Error('J_DISPUTE_FINALIZATION_SIDECAR_ABI_MISMATCH');
}
console.log('J_EVENT_CATALOG_OK contracts=2 disputeBodies=3');
