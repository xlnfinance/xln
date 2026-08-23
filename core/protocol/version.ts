// Testnet runs a single protocol version: every incompatible change resets
// the network and stays v1. Version history lives in git, not in a runtime
// compatibility ladder — peers on a different build are refused at hello.
export const XLN_PROTOCOL_VERSION = 1 as const;

export type XlnProtocolVersion = typeof XLN_PROTOCOL_VERSION;
