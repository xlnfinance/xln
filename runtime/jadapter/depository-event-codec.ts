import type { LogDescription } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types/index.ts';

type DepositoryLog = {
  topics: readonly string[];
  data: string;
};

// Parse against the generated contract ABI, not a hand-maintained canonical
// subset. Depository telemetry is intentionally non-consensus, but it must be
// recognized before the watcher can safely filter it from canonical J-events.
const depositoryInterface = Depository__factory.createInterface();

export const parseKnownDepositoryLog = (log: DepositoryLog): LogDescription | null =>
  depositoryInterface.parseLog({ topics: [...log.topics], data: log.data });

export const extractCanonicalDepositoryEventArgs = (
  parsed: LogDescription,
): Record<string, unknown> => {
  const args: Record<string, unknown> = {};
  for (let index = 0; index < parsed.fragment.inputs.length; index++) {
    const input = parsed.fragment.inputs[index];
    if (!input) continue;
    const value = parsed.args[index];
    args[input.name || String(index)] = value;
    if (input.name) args[input.name] = value;
  }

  // Solidity calls this field `nonce`, while the runtime event schema calls it
  // `initialNonce` to distinguish it from the post-finalization Account nonce.
  if (parsed.name === 'DisputeFinalized') {
    if (args['nonce'] === undefined) throw new Error('J_DISPUTE_FINALIZED_NONCE_MISSING');
    args['initialNonce'] = args['nonce'];
  }
  return args;
};
