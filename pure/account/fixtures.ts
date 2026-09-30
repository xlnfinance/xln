// What the account tests share: the holds they lock. Only tests import this.
import { holdId, type Hold, type Side } from "./model.ts";

/** A hold in slot `id`. */
export const holdOf = (payer: Side, amount: bigint, id = 1n): Hold => ({ id: holdId(id), payer, amount });
