/**
 * What this side sends after the engine executed, built from the verdict.
 *
 * The account body stays in Rust. The acknowledgement and the proposal the
 * Entity puts on the wire are derived from the verdict plus the envelope
 * fields the Entity already knows — never by reading a copy of the account
 * back across the process boundary.
 *
 * Parity target: `buildIncomingFrameAckMaterial` and `finalizeAccountProposal`
 * in core/account/consensus, which build the same two shapes in TypeScript.
 */
import { copyAccountDisputeConfig, copyAccountStateDomain } from '../../protocol/state/account-input-clone';
import type { AccountConsensusHashToSign } from '../../account/consensus/types';
import type { AccountDisputeHanko, AccountPeerInput, AccountReplica } from '../../types/account';
import type { WaveDisputeDraft } from '../wave-decode';

/** The envelope every peer input repeats, as this Account already holds it. */
export type CutoverEnvelope = Readonly<{
  fromEntityId: string;
  toEntityId: string;
  domain: AccountPeerInput['domain'];
  disputeConfig: AccountPeerInput['disputeConfig'];
  watchSeed?: string;
}>;

export const cutoverEnvelope = (account: AccountReplica): CutoverEnvelope => ({
  fromEntityId: account.proofHeader.fromEntity,
  toEntityId: account.proofHeader.toEntity,
  domain: copyAccountStateDomain(account.state.domain),
  disputeConfig: copyAccountDisputeConfig(account.state.disputeConfig),
  ...(account.state.watchSeed === undefined ? {} : { watchSeed: account.state.watchSeed }),
});

/**
 * A draft the Entity has not signed yet. The Hanko slot stays empty and the
 * hash is published for the witness pass, exactly as the TypeScript
 * transition leaves it.
 */
const disputeDraft = (draft: WaveDisputeDraft): AccountDisputeHanko => ({
  hash: draft.hash,
  proofBodyHash: draft.proofBodyHash,
  proofNonce: draft.nonce,
  proposerIsLeft: draft.proposerIsLeft,
});

export const cutoverAck = (
  envelope: CutoverEnvelope,
  height: number,
  frameHash: string,
  dispute: WaveDisputeDraft | null,
): Extract<AccountPeerInput, { kind: 'ack' }> => ({
  kind: 'ack',
  ...envelope,
  ack: {
    height,
    frameHash,
    ...(dispute === null ? {} : { disputeHanko: disputeDraft(dispute) }),
  },
});

const accountPrefix = (accountId: string): string => `account:${accountId.slice(-8)}`;

/** The hashes the Entity's witness pass must sign for this operation. */
export const cutoverAckHashes = (
  accountId: string,
  height: number,
  frameHash: string,
  dispute: WaveDisputeDraft | null,
): AccountConsensusHashToSign[] => [
  { hash: frameHash, type: 'accountFrame', context: `${accountPrefix(accountId)}:ack:${height}` },
  ...(dispute === null
    ? []
    : [{
        hash: dispute.hash,
        type: 'dispute' as const,
        context: `${accountPrefix(accountId)}:ack-dispute`,
      }]),
];
