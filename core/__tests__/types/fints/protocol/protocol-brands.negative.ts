import { toEntityId, toRuntimeId, type AccountPairKey, type RuntimeId, type SignerId } from '../../../../protocol/identity';
import { toRuntimeHeight, toUnixMs, type EntityHeight, type UnixS } from '../../../../protocol/units';
import { toEvidenceHash, toFrameHash, type StateHash } from '../../../../protocol/hashes';

export const entityIsNotSigner: SignerId = toEntityId(`0x${'11'.repeat(32)}`);
export const runtimeIsNotEntitySigner: SignerId = toRuntimeId(`0x${'22'.repeat(20)}`);
export const millisecondsAreNotSeconds: UnixS = toUnixMs(1_000);
export const runtimeHeightIsNotEntityHeight: EntityHeight = toRuntimeHeight(1);
export const plainStringCannotMintRuntimeAuthority: RuntimeId = `0x${'33'.repeat(20)}`;
export const entityIsNotAccountPair: AccountPairKey = toEntityId(`0x${'44'.repeat(32)}`);
export const frameHashIsNotStateRoot: StateHash = toFrameHash(`0x${'55'.repeat(32)}`);
export const evidenceHashIsNotStateRoot: StateHash = toEvidenceHash(`0x${'66'.repeat(32)}`);
