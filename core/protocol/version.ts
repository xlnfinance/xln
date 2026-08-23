// v2 (2026-08-23): AES-256-GCM transport and HTLC layers, binary Entity frame
// preimage (context by digest), flat Account commitments. A v1 peer must be
// refused at hello rather than fail later on a hash mismatch.
// v3 (2026-08-23): msgpack codec without structured-clone reference markers
// (bytes depend on value only), Buffer/Uint8Array one form, consensus roots
// and command hashes over canonical bytes.
// v4 (2026-08-23): committed trusted-payment forwarding is an ordered typed
// Account output; the persisted pendingForwards side channel is retired under
// storage schema 9.
export const XLN_PROTOCOL_VERSION = 4 as const;

export type XlnProtocolVersion = typeof XLN_PROTOCOL_VERSION;
