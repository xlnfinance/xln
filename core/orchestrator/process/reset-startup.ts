import { scheduler } from 'node:timers/promises';
import type { HubChild, ResetState } from '../orchestrator-types';
import { HUB_BASELINE_TIMEOUT_MS, HUB_REQUIRED_TOKEN_COUNT } from '../orchestrator-config';
import { captureAuthorityEvidenceBase } from './authority-evidence-base';
import { DEFAULT_ACCOUNT_TOKEN_IDS } from '../../account/config/defaults';
import { getTokenIdsForJurisdiction } from '../../account/utils';
import type { ManagedPeerIdentity } from '../market-maker/identity-resolver';

type BootstrapOwner = { entityId: string; signerId: string; jurisdictionName: string };

export const planNativeHubBootstrapPeers = (
  primaryEntityId: string,
  owners: readonly BootstrapOwner[],
  hubs: readonly { name: string; owners: readonly BootstrapOwner[] }[],
  supportIdentities: readonly ManagedPeerIdentity[],
) => owners.flatMap(owner => {
  // Match hub-node planMeshBootstrapInputs: named hub mesh belongs to the
  // primary Entity; MM Accounts belong to every jurisdiction's local owner.
  // Requiring secondary H2/H3 Accounts waits forever: no peer opens them.
  const hubPeers = owner.entityId === primaryEntityId ? hubs.flatMap(peer => peer.owners
    .filter(entity => entity.jurisdictionName === owner.jurisdictionName)
    .map(entity => ({ name: peer.name, isHub: true, entityId: entity.entityId, tokenIds: [...DEFAULT_ACCOUNT_TOKEN_IDS] as number[] }))) : [];
  const supportPeers = supportIdentities
    .filter(peer => peer.jurisdictionName === owner.jurisdictionName)
    .map(peer => {
      const configured = getTokenIdsForJurisdiction({ name: peer.jurisdictionName, chainId: peer.chainId });
      return { name: peer.name, isHub: false, entityId: peer.entityId, tokenIds: configured.length >= HUB_REQUIRED_TOKEN_COUNT ? configured : [...DEFAULT_ACCOUNT_TOKEN_IDS] };
    });
  return [...hubPeers, ...supportPeers].map(peer => ({ ...peer, ownerEntityId: owner.entityId, ownerSignerId: owner.signerId }));
});

export const waitForNativeH1DeliveryReady = async (
  h1: HubChild,
  resetState: Pick<ResetState, 'inProgress'>,
  pollHubHealth: (child: HubChild) => Promise<void>,
): Promise<void> => {
  const startedAt = Date.now();
  while (resetState.inProgress && h1.proc && h1.exitCode === null && h1.exitSignal === null) {
    await pollHubHealth(h1);
    if (h1.proc.exitCode !== null || h1.proc.signalCode !== null) break;
    // Identity/profile publication permits recovery traffic before J catch-up. Only
    // the native post-WAL barrier authorizes the financial bootstrap policy below.
    if (h1.lastInfo?.deliveryReady === true) return;
    if (Date.now() - startedAt >= HUB_BASELINE_TIMEOUT_MS) {
      throw new Error(`RUST_H1_J_CATCHUP_TIMEOUT:height=${String(h1.lastHealth?.height)}:` +
        `phase=${String(h1.lastHealth?.runtime?.lifecyclePhase)}`);
    }
    await scheduler.wait(250);
  }
  throw new Error('RUST_H1_J_CATCHUP_STOPPED');
};

export const completeResetStartup = async (
  startup: Readonly<{
    h1: HubChild;
    host: string;
    shouldStartMarketMaker: boolean;
    preserveState: boolean;
    waitForMesh: () => Promise<void>;
    driveH1Bootstrap: () => Promise<void>;
    startMarketMaker: () => Promise<void>;
    startCustody: () => Promise<void>;
  }>,
): Promise<void> => {
  const parallel = () =>
    Promise.all([startup.driveH1Bootstrap(), startup.startMarketMaker(), startup.startCustody()]).then(() => undefined);
  // Restored Accounts can wait for MM/custody ACKs before reserve refill.
  // Only a fresh recording owns the pre-Account capture barrier.
  if (process.env['XLN_HLT_AUTHORITY_EVIDENCE'] !== '1' || startup.preserveState) {
    await Promise.all([startup.waitForMesh(), parallel()]);
    return;
  }
  // Capture H1 before MM or custody can open an Account, so the workload WAL
  // owns every later Account transition without a fabricated checkpoint frame.
  // The mesh baseline includes H1-owned reserves. Waiting for it before driving
  // that funding deadlocks cross-j startup; MM and custody must still wait for capture.
  await Promise.all([startup.waitForMesh(), startup.driveH1Bootstrap()]);
  await captureAuthorityEvidenceBase(startup.h1, startup.host);
  await Promise.all([startup.startMarketMaker(), startup.startCustody()]);
};
