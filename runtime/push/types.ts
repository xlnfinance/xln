/**
 * xln push-wake module types.
 *
 * Server-only. Never imported by the browser runtime bundle or the RJEA
 * consensus path. The push module lets a watchtower observe on-chain
 * DisputeStarted events and wake the victim's device so the user can open the
 * wallet, sync, and respond before the dispute window closes.
 *
 * It holds NO keys and NO spend authority. It stores only a registry mapping an
 * entity to opaque device push tokens plus a pluggable notification transport.
 * On-chain disputes are already public, so the only new metadata the tower
 * learns is the entity -> device-token linkage.
 */

export type PushPlatformV1 = 'ios' | 'android' | 'web' | 'desktop';

export type PushRegistrationRequestV1 = {
  type: 'push_registration';
  version: 1;
  runtimeId: string;
  entityId: string;
  token: string;
  platform: PushPlatformV1;
  chainId: number;
  depositoryAddress: string;
  rpcUrl: string;
  signedAt: number;
  ownerSignature: string;
};

export type PushUnregisterRequestV1 = {
  type: 'push_unregister';
  version: 1;
  runtimeId: string;
  token: string;
  signedAt: number;
  ownerSignature: string;
};

export type StoredPushRegistration = {
  runtimeId: string;
  entityId: string;
  tokenHash: string;
  token: string;
  platform: PushPlatformV1;
  chainId: number;
  depositoryAddress: string;
  rpcUrl: string;
  signedAt: number;
  updatedAt: number;
};

export type DisputeWakeEvent = {
  chainId: number;
  depositoryAddress: string;
  sender: string; // dispute starter entityId
  counterentity: string; // victim entityId
  nonce: number;
  blockNumber: number;
  txHash?: string;
};

export type DisputeWakeTarget = {
  registration: StoredPushRegistration;
  event: DisputeWakeEvent;
};

export type PushNotificationV1 = {
  token: string;
  platform: PushPlatformV1;
  title: string;
  body: string;
  data: Record<string, string>;
  collapseKey: string;
};

export type PushSendResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
};

export interface PushSender {
  readonly kind: string;
  send(notification: PushNotificationV1): Promise<PushSendResult>;
}
