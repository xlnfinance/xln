// R-J3: what a draft may hold so that every batch made from it is one the Depository accepts.
//
// The limits are per batch, and the ops of a draft travel in groups (R-SPLIT, J6, R-COSIGN, a finalize alone), so a
// draft is judged group by group: two finalizes are two batches and no limit is crossed, while nine dispute starts are
// one group and are. The draft as a whole is bounded by the most ops one batch may carry, which is the page's draft
// cap. One limit depends on what is encoded: a count of ops does not say how big their proofs are, and two dispute
// starts of 140 KiB each pass every count and cannot be one batch. A group that could never be sealed would stop
// everything behind it, so the op that makes a group too large, the op that cannot fit alone and the op that cannot be
// encoded at all are refused when they are queued.
import { encodeBatch } from "../../chain/batch/batch.ts";
import type { AbiFault } from "../../kernel/encoding/abi.ts";
import { none, some, type Option } from "../../kernel/core/option.ts";
import { map, type Result } from "../../kernel/core/result.ts";
import type { Tagged } from "../../kernel/core/tagged.ts";
import { assemble } from "../op/assemble.ts";
import { MAX_ENCODED_BYTES, TOTAL_LIMIT, withinLimits, type LimitFault } from "../op/limits.ts";
import type { JOp } from "../op/ops.ts";
import { groupsOf, type Group } from "./group.ts";

export type SizeFault =
  | Tagged<"group_too_large", { bytes: number; max: number }>
  | Tagged<"unencodable", { fault: AbiFault }>;

export type FitFault = LimitFault | SizeFault;

/** The bytes the Depository decodes for these ops (the gas budget is a fixed-size field, so its value is no matter). */
export const encodedBytes = (ops: Group): Result<number, AbiFault> =>
  map(encodeBatch(assemble(0n, ops)), (encoded) => (encoded.length - 2) / 2);

const sizeFault = (group: Group): Option<FitFault> => {
  const size = encodedBytes(group);
  if (!size.ok) return some({ _tag: "unencodable", fault: size.error });
  return size.value > MAX_ENCODED_BYTES
    ? some({ _tag: "group_too_large", bytes: size.value, max: MAX_ENCODED_BYTES })
    : none;
};

/** The counts of one batch, then its bytes. */
const groupFault = (group: Group): Option<FitFault> => {
  const counted = withinLimits(group);
  return counted.ok ? sizeFault(group) : some(counted.error);
};

/** The first limit this draft passes, or none when every batch made from it is one the Depository accepts. */
export const fitFault = (self: string, draft: readonly JOp[]): Option<FitFault> => {
  if (draft.length > TOTAL_LIMIT) return some({ _tag: "too_many_ops", total: draft.length, max: TOTAL_LIMIT });
  return groupsOf(self, draft).map(groupFault).find((fault) => fault._tag === "some") ?? none;
};
