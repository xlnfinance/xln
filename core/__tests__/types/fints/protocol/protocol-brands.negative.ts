import { toEntityId, toRuntimeId, type RuntimeId, type SignerId } from '../../../../protocol/identity';
import { toRuntimeHeight, toUnixMs, type EntityHeight, type UnixS } from '../../../../protocol/units';
import { toFrameHash, type StateHash } from '../../../../protocol/hashes';

export const entityIsNotSigner: SignerId = toEntityId(`0x${'11'.repeat(32)}`);
export const runtimeIsNotEntitySigner: SignerId = toRuntimeId(`0x${'22'.repeat(20)}`);
export const millisecondsAreNotSeconds: UnixS = toUnixMs(1_000);
export const runtimeHeightIsNotEntityHeight: EntityHeight = toRuntimeHeight(1);
export const plainStringCannotMintRuntimeAuthority: RuntimeId = `0x${'33'.repeat(20)}`;
export const frameHashIsNotStateRoot: StateHash = toFrameHash(`0x${'55'.repeat(32)}`);
