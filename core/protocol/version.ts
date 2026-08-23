// v2 (2026-08-23): AES-256-GCM transport and HTLC layers, binary Entity frame
// preimage (context by digest), flat Account commitments. A v1 peer must be
// refused at hello rather than fail later on a hash mismatch.
export const XLN_PROTOCOL_VERSION = 2 as const;

export type XlnProtocolVersion = typeof XLN_PROTOCOL_VERSION;
