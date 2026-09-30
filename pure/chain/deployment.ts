// Which Depository a signature is for, and which Account a message is about.
//
// The contracts bind every signed payload to the chain id and to their own address, so a signature for one deployment
// can never be replayed on another. A `Deployment` is that pair, validated once; the payload encoders take it whole.
import { err, flatMap, ok, type Result } from "../kernel/result.ts";
import { checksum } from "../kernel/signature.ts";
import type { Tagged } from "../kernel/tagged.ts";

export type Deployment = Readonly<{ chainId: bigint; depository: string }>;
export type DeploymentFault = Tagged<"bad_chain_id" | "bad_depository" | "bad_checksum" | "zero_depository">;

const UINT256_LIMIT = 1n << 256n;
const ADDRESS_TEXT = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;

/** A mixed-case address must carry its EIP-55 checksum; the stored spelling is lowercase. */
const lowercaseAddress = (text: string): Result<string, DeploymentFault> => {
  const mixedCase = /[a-f]/.test(text.slice(2)) && /[A-F]/.test(text.slice(2));
  switch (true) {
    case !ADDRESS_TEXT.test(text): return err({ _tag: "bad_depository" });
    case mixedCase && checksum(text) !== text: return err({ _tag: "bad_checksum" });
    case ZERO_ADDRESS.test(text): return err({ _tag: "zero_depository" });
    default: return ok(text.toLowerCase());
  }
};

export const deployment = (chainId: bigint, depository: string): Result<Deployment, DeploymentFault> => {
  if (chainId <= 0n || chainId >= UINT256_LIMIT) return err({ _tag: "bad_chain_id" });
  return flatMap(lowercaseAddress(depository), (address) => ok({ chainId, depository: address }));
};

export type AccountKeyFault = Tagged<"not_bytes32">;

/** `abi.encodePacked(min(a, b), max(a, b))` over the two entity ids: the key both sides name an Account by. */
export const accountKey = (a: string, b: string): Result<string, AccountKeyFault> => {
  const isWord = (id: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(id);
  if (!isWord(a) || !isWord(b)) return err({ _tag: "not_bytes32" });
  const [lesser, greater] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return ok(`0x${lesser.slice(2)}${greater.slice(2)}`.toLowerCase());
};
