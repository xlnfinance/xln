/**
 * Creates the real numbered Entities used by the company lifecycle scenario.
 * It covers both a one-member company and a 2-of-3 board without synthesizing
 * registry state: every board is first observed from EntityProvider history.
 */

import type { ConsensusConfig } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import { encodeBoard, generateNumberedEntityId } from '../../entity/factory';
import {
  bindScenarioJReplica,
  createJReplica,
  createJurisdictionConfig,
  ensureJAdapter,
  getJAdapterMode,
  registerEntities,
  resolveScenarioBoardSigner,
} from '../harness/boot';
import {
  commitRuntimeInput,
  converge,
  ensureSignerKeysFromSeed,
  processJEvents,
  requireRuntimeSeed,
  syncChain,
} from '../harness/helpers';
import { importBoardReplicas } from '../consensus/multi-sig';
import type { CompanyActor, CompanyScenarioActors } from './model';

const equalShares = (validators: string[]): Record<string, bigint> =>
  Object.fromEntries(validators.map(validator => [validator, 1n]));

const singleActor = (
  registered: { id: string; name: string; signer: string },
  jurisdiction: CompanyScenarioActors['jurisdiction'],
): CompanyActor => ({
  id: registered.id,
  name: registered.name,
  validators: [registered.signer],
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [registered.signer],
    shares: { [registered.signer]: 1n },
    jurisdiction,
  },
});

const registerBoardCompany = async (
  env: RuntimeReplica,
  actors: Pick<CompanyScenarioActors, 'jadapter' | 'jurisdiction'>,
  validators: string[],
): Promise<CompanyActor> => {
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 2n,
    validators,
    shares: equalShares(validators),
    jurisdiction: actors.jurisdiction,
  };
  // Registration takes the abi.encode(Board) preimage; the contract validates
  // reachability and stores keccak256 of it as the board hash.
  const encodedBoard = encodeBoard(config, env);
  const nextNumber = await actors.jadapter.entityProvider.nextNumber();
  const tx = await actors.jadapter.entityProvider.registerNumberedEntity(encodedBoard);
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error('COMPANY_BOARD_REGISTRATION_FAILED');
  const id = generateNumberedEntityId(Number(nextNumber)).toLowerCase();
  await syncChain(env, 3);
  await commitRuntimeInput(env, {
    runtimeTxs: importBoardReplicas(env, id, config, 180),
    entityInputs: [],
  });
  await processJEvents(env);
  await converge(env, 20);
  return { id, name: 'Acme Board Company', validators, config };
};
export const formCompanyActors = async (env: RuntimeReplica): Promise<CompanyScenarioActors> => {
  requireRuntimeSeed(env, 'Company IPO');
  ensureSignerKeysFromSeed(env, ['1', '2', '3', '4', '5', '6'], 'Company IPO');
  const jadapter = await ensureJAdapter(env, getJAdapterMode());
  const jurisdictionName = 'Company IPO';
  bindScenarioJReplica(
    env,
    createJReplica(env, jurisdictionName, jadapter.addresses.depository),
    jadapter,
  );
  jadapter.startWatching(env);
  const jurisdiction = createJurisdictionConfig(
    jurisdictionName,
    jadapter.addresses.depository,
    jadapter.addresses.entityProvider,
    jadapter.mode === 'browservm' ? 'browservm://' : process.env['ANVIL_RPC'],
    Number(jadapter.chainId),
  );
  const singles = await registerEntities(env, jadapter, [
    { name: 'Company Hub', signer: '1', position: { x: 0, y: -20, z: 0 } },
    { name: 'Investor', signer: '2', position: { x: 80, y: -60, z: 0 } },
    { name: 'Solo Company', signer: '3', position: { x: -80, y: -60, z: 0 } },
  ], jurisdiction);
  const [hub, investor, soloCompany] = singles;
  if (!hub || !investor || !soloCompany) throw new Error('COMPANY_SINGLE_REGISTRATION_INCOMPLETE');
  // The investor starts as a minority director (1 of 3, threshold 2). This is
  // a realistic pre-approved successor path: CONTROL ownership may later make
  // that director the sole board without requiring the retired board to hand
  // over the Entity encryption key after the takeover.
  const boardValidators = ['2', '5', '6'].map(alias => resolveScenarioBoardSigner(env, alias));
  const boardCompany = await registerBoardCompany(env, { jadapter, jurisdiction }, boardValidators);
  return {
    jadapter,
    jurisdiction,
    hub: singleActor(hub, jurisdiction),
    investor: singleActor(investor, jurisdiction),
    soloCompany: singleActor(soloCompany, jurisdiction),
    boardCompany,
  };
};
