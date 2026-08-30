import {
  createReplicaKey,
  createAccountPairKey,
  formatReplicaKey,
  toEntityId,
  toJId,
  toRuntimeId,
  toSignerId,
  type EntityId,
  type AccountPairKey,
  type JId,
  type RuntimeId,
  type SignerId,
} from '../../../../protocol/identity';
import {
  toAccountHeight,
  toEntityHeight,
  toJHeight,
  toRuntimeHeight,
  toUnixMs,
  toUnixS,
  type AccountHeight,
  type EntityHeight,
  type JHeight,
  type RuntimeHeight,
  type UnixMs,
  type UnixS,
} from '../../../../protocol/units';
import type { DecodedRuntimeEntityInputsEnvelope } from '../../../../network/p2p/auth/entity-input-envelope';
import type { DecodedRuntimeInput } from '../../../../runtime/decode';
import type { DecodedJInput, DecodedJTx } from '../../../../storage/wal/runtime-machine-schema/j';
import {
  parseSnapshotEntityKey,
} from '../../../../storage/keys';
import type { DecodedAccountFrame } from '../../../../account/validation/frame-validation';
import type { DecodedEntityFrame } from '../../../../entity/consensus/frame/validation';
import type { DecodedProfile } from '../../../../entity/profile';
import {
  toEvidenceHash,
  toFrameHash,
  toStateHash,
  type EvidenceHash,
  type FrameHash,
  type StateHash,
} from '../../../../protocol/hashes';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type NotEqual<A, B> = Equal<A, B> extends true ? false : true;

type DistinctIdentities = Expect<NotEqual<EntityId, SignerId>>;
type PairIsNotEntity = Expect<NotEqual<AccountPairKey, EntityId>>;
type DistinctRuntimeAndJ = Expect<NotEqual<RuntimeId, JId>>;
type DistinctTimes = Expect<NotEqual<UnixMs, UnixS>>;
type DistinctMachineHeights = Expect<NotEqual<RuntimeHeight, EntityHeight>>;
type DistinctAccountAndJHeights = Expect<NotEqual<AccountHeight, JHeight>>;
type P2PSourceIsRuntime = Expect<Equal<DecodedRuntimeEntityInputsEnvelope['sourceRuntimeId'], RuntimeId>>;
type P2PClockIsUnixMs = Expect<Equal<DecodedRuntimeEntityInputsEnvelope['sourceRuntimeTimestamp'], UnixMs>>;
type RuntimeIngressClockIsUnixMs = Expect<Equal<NonNullable<DecodedRuntimeInput['timestamp']>, UnixMs>>;
type RuntimeIngressEntityIsEntity = Expect<Equal<DecodedRuntimeInput['entityInputs'][number]['entityId'], EntityId>>;
type RuntimeIngressSignerIsSigner = Expect<Equal<DecodedRuntimeInput['entityInputs'][number]['signerId'], SignerId>>;
type RuntimeIngressTargetIsRuntime = Expect<Equal<NonNullable<DecodedRuntimeInput['entityInputs'][number]['runtimeId']>, RuntimeId>>;
type WalJurisdictionIsJId = Expect<Equal<DecodedJInput['jurisdictionName'], JId>>;
type WalJTxClockIsUnixMs = Expect<Equal<DecodedJTx['timestamp'], UnixMs>>;
type StorageRuntimeHeight = Expect<Equal<ReturnType<typeof parseSnapshotEntityKey>['height'], RuntimeHeight>>;
type DistinctFrameAndStateHashes = Expect<NotEqual<FrameHash, StateHash>>;
type DistinctEvidenceAndFrameHashes = Expect<NotEqual<EvidenceHash, FrameHash>>;
type AccountDecoderMintsHeight = Expect<Equal<DecodedAccountFrame['height'], AccountHeight>>;
type AccountDecoderMintsRoot = Expect<Equal<DecodedAccountFrame['accountStateRoot'], StateHash>>;
type EntityDecoderMintsHeight = Expect<Equal<DecodedEntityFrame['height'], EntityHeight>>;
type EntityDecoderMintsClock = Expect<Equal<DecodedEntityFrame['timestamp'], UnixMs>>;
type ProfileDecoderMintsEntity = Expect<Equal<DecodedProfile['entityId'], EntityId>>;
type ProfileDecoderMintsRuntime = Expect<Equal<DecodedProfile['runtimeId'], RuntimeId>>;

const entityId = toEntityId(`0x${'11'.repeat(32)}`);
const signerId = toSignerId('validator-1');

export const fintsPositiveProtocolBrands = (): readonly [
  string,
  RuntimeId,
  JId,
  UnixMs,
  UnixS,
  RuntimeHeight,
  EntityHeight,
  AccountHeight,
  JHeight,
  AccountPairKey,
  FrameHash,
  StateHash,
  EvidenceHash,
  DistinctIdentities,
  PairIsNotEntity,
  DistinctRuntimeAndJ,
  DistinctTimes,
  DistinctMachineHeights,
  DistinctAccountAndJHeights,
  P2PSourceIsRuntime,
  P2PClockIsUnixMs,
  RuntimeIngressClockIsUnixMs,
  RuntimeIngressEntityIsEntity,
  RuntimeIngressSignerIsSigner,
  RuntimeIngressTargetIsRuntime,
  WalJurisdictionIsJId,
  WalJTxClockIsUnixMs,
  StorageRuntimeHeight,
  DistinctFrameAndStateHashes,
  DistinctEvidenceAndFrameHashes,
  AccountDecoderMintsHeight,
  AccountDecoderMintsRoot,
  EntityDecoderMintsHeight,
  EntityDecoderMintsClock,
  ProfileDecoderMintsEntity,
  ProfileDecoderMintsRuntime,
] => [
  formatReplicaKey(createReplicaKey(entityId, signerId)),
  toRuntimeId(`0x${'22'.repeat(20)}`),
  toJId('31337'),
  toUnixMs(1_000),
  toUnixS(1),
  toRuntimeHeight(1),
  toEntityHeight(1),
  toAccountHeight(1),
  toJHeight(1),
  createAccountPairKey(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`),
  toFrameHash(`0x${'33'.repeat(32)}`),
  toStateHash(`0x${'44'.repeat(32)}`),
  toEvidenceHash(`0x${'55'.repeat(32)}`),
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
