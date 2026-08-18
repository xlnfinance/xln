import type { JTx } from '../../types/jurisdiction-runtime';

/** Deterministic child-machine input routed from Entity to Jurisdiction. */
export interface JInput {
  jurisdictionName: string;
  jTxs: JTx[];
}
