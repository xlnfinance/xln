/**
 * Pure dispute-wake matching and notification building.
 *
 * Given a DisputeStarted event, decide which registered devices to wake. Only
 * the victim — the counterentity of the dispute — is woken. The starter (event
 * sender) initiated the dispute and needs no wake. An entity cannot be both
 * starter and counterentity, so matching counterentity inherently excludes the
 * starter.
 */

import type {
  DisputeWakeEvent,
  DisputeWakeTarget,
  PushNotificationV1,
  StoredPushRegistration,
} from './types';

export const selectWakeTargets = (
  event: DisputeWakeEvent,
  registrations: readonly StoredPushRegistration[],
): DisputeWakeTarget[] => {
  const victim = String(event.counterentity || '').toLowerCase();
  const starter = String(event.sender || '').toLowerCase();
  if (!victim || victim === starter) return [];
  const depository = String(event.depositoryAddress || '').toLowerCase();
  const targets: DisputeWakeTarget[] = [];
  for (const registration of registrations) {
    if (registration.chainId !== event.chainId) continue;
    if (registration.depositoryAddress.toLowerCase() !== depository) continue;
    if (registration.entityId.toLowerCase() !== victim) continue;
    targets.push({ registration, event });
  }
  return targets;
};

export const disputeWakeCollapseKey = (event: DisputeWakeEvent): string =>
  `dispute:${event.chainId}:${String(event.depositoryAddress).toLowerCase()}:${String(event.counterentity).toLowerCase()}:${event.nonce}`;

export const buildDisputeWakeNotification = (target: DisputeWakeTarget): PushNotificationV1 => {
  const shortStarter = target.event.sender.slice(-6);
  return {
    token: target.registration.token,
    platform: target.registration.platform,
    title: 'Open xln to protect your account',
    body: `A dispute was opened against your account by …${shortStarter}. Open xln, sync, and respond before the window closes.`,
    data: {
      kind: 'dispute_wake',
      chainId: String(target.event.chainId),
      depository: String(target.event.depositoryAddress).toLowerCase(),
      entityId: target.registration.entityId.toLowerCase(),
      counterparty: target.event.sender.toLowerCase(),
      nonce: String(target.event.nonce),
      url: 'xln://wallet',
    },
    collapseKey: disputeWakeCollapseKey(target.event),
  };
};
