import { accountInputAck, accountInputDisputeHanko, accountInputProposal } from '../../../../account/consensus/flush';
import { primeRecoveredHankoSignatures } from '../../../../hanko/codec';
import { cryptoPoolEnabled } from '../../../../protocol/crypto/crypto-pool';
import type { EntityTx } from '../../../../types/entity-tx';

/**
 * Every inbound Account input carries the digests its Hankos sign (frame
 * `stateHash`, ack `frameHash`, disputeHanko `hash`). Recover all of them on the worker
 * pool while the main thread fits the proposal, so the synchronous verifiers in
 * frame apply hit the memo instead of running secp256k1 one input at a time.
 * Acceptance is unchanged: the verifiers still rebuild and compare every digest.
 */
export const primeProposalHankos = (txs: readonly EntityTx[]): Promise<number> | null => {
  if (!cryptoPoolEnabled()) return null;
  const items: { digest: string; hanko: string }[] = [];
  for (const tx of txs) {
    if (tx.type !== 'accountInput') continue;
    const input = tx.data;
    const proposal = accountInputProposal(input);
    if (proposal?.frameHanko) {
      items.push({ digest: proposal.frame.stateHash, hanko: proposal.frameHanko });
      if (proposal.disputeHanko?.hanko) {
        items.push({ digest: proposal.disputeHanko.hash, hanko: proposal.disputeHanko.hanko });
      }
    }
    const ack = accountInputAck(input);
    if (ack?.frameHanko) {
      items.push({ digest: ack.frameHash, hanko: ack.frameHanko });
      if (ack.disputeHanko?.hanko) {
        items.push({ digest: ack.disputeHanko.hash, hanko: ack.disputeHanko.hanko });
      }
    }
    const disputeHanko = accountInputDisputeHanko(input);
    if (disputeHanko?.hanko) items.push({ digest: disputeHanko.hash, hanko: disputeHanko.hanko });
  }
  if (items.length === 0) return null;
  return primeRecoveredHankoSignatures(items).catch(() => 0);
};
