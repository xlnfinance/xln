import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveRuntimeAdapterCapabilityToken } from '../../../api/runtime-adapter/security/auth';
import type { Profile } from '../../../entity/profile';
import type { ProfileVerifyResult } from '../../../entity/profile/profile-signing';
import { DaemonControlClient } from '../../daemon-control';
import type { HubChild } from '../../orchestrator-types';

export const verifyManagedHubProfile = (
  hub: HubChild,
  host: string,
  profile: Profile,
): Promise<ProfileVerifyResult> => {
  // The orchestrator owns this process, endpoint and credential. The announced
  // profile cannot choose its authority server. H1 observes the configured
  // stacks; its committed registry rejects unknown stacks and stale boards.
  const runtimeId = deriveSignerAddressSync(hub.seed, '1').toLowerCase();
  const authKey = deriveRuntimeAdapterCapabilityToken(hub.authSeed, 'full', Date.now() + 60_000, {
    audience: runtimeId,
    keyId: hub.name.toLowerCase(),
  });
  return new DaemonControlClient({
    baseUrl: `http://${host}:${hub.apiPort}`,
    authKey,
    timeoutMs: 10_000,
  }).verifyProfile(profile);
};
