/**
 * Whether the Entity re-derives what the engine already committed.
 *
 * The engine is the authority: it owns the Account, computes both roots and
 * publishes the Entity leaf. Recomputing all of that in TypeScript proves the
 * two sides agree, and costs more than the transition it checks. It stays on
 * by default — a bring-up that silently trusted a divergent engine would sign
 * frames nobody can reproduce — and a throughput run that has already proven
 * parity turns it off explicitly.
 */
export const RSCORE_CUTOVER_VERIFY = process.env['XLN_RSCORE_CUTOVER_TRUST_ENGINE'] !== '1';