import { toRuntimeHeight, toUnixMs, type EntityHeight, type UnixS, asTokenId, toUnixS, type UnixMs, type TokenId } from '../../../../protocol/units';
import { toEntityId, toRuntimeId, type RuntimeId, type SignerId } from '../../../../protocol/identity';

import { toFrameHash, type StateHash } from '../../../../protocol/hashes';

type WidenedSignerId = SignerId | ReturnType<typeof toEntityId> | ReturnType<typeof toRuntimeId>;
type WidenedUnixS = UnixS | ReturnType<typeof toUnixMs>;
type WidenedEntityHeight = EntityHeight | ReturnType<typeof toRuntimeHeight>;
type WidenedRuntimeId = RuntimeId | string;
type WidenedStateHash = StateHash | ReturnType<typeof toFrameHash>;

export const entityAsWidenedSigner: WidenedSignerId = toEntityId(`0x${'11'.repeat(32)}`);
export const runtimeAsWidenedSigner: WidenedSignerId = toRuntimeId(`0x${'22'.repeat(20)}`);
export const millisecondsAsWidenedSeconds: WidenedUnixS = toUnixMs(1_000);
export const runtimeAsWidenedEntityHeight: WidenedEntityHeight = toRuntimeHeight(1);
export const stringAsWidenedRuntimeId: WidenedRuntimeId = `0x${'33'.repeat(20)}`;
export const frameAsWidenedState: WidenedStateHash = toFrameHash(`0x${'55'.repeat(32)}`);


export const secondsAsWidenedMilliseconds: UnixMs | ReturnType<typeof toUnixS> = toUnixS(1);
export const millisecondsAsWidenedTokens: TokenId | ReturnType<typeof toUnixMs> = toUnixMs(1);
export const tokensAsWidenedSeconds: UnixS | ReturnType<typeof asTokenId> = asTokenId(1);
export const numberAsWidenedToken: TokenId | number = 1;
