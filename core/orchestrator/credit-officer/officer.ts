import type { RuntimeAdapter } from '../../api/runtime-adapter/types';
import { CreditLedger } from './ledger';
import { creditDifficulty, creditUsd, scoreCredit } from './policy';
import { decodeCreditRequest, proofDigest, validCreditProof } from './proof';
import { readCreditEvidence } from './runtime';

export class CreditOfficer {
  private busy = false;
  constructor(
    private ledger: CreditLedger,
    private adapters: ReadonlyMap<string, RuntimeAdapter>,
  ) {}

  async decide(value: unknown, now = Date.now()) {
    try {
      return await this.evaluate(value, now);
    } catch (cause) {
      this.ledger.audit({
        creditOfficer: 'denied',
        request: value,
        now,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
  }

  private async evaluate(value: unknown, now: number) {
    const request = decodeCreditRequest(value);
    const adapter = this.adapters.get(request.hubEntityId);
    if (!adapter) throw new Error('WRONG_HUB');
    const usd = creditUsd(request.tokenId, BigInt(request.amount));
    if (!validCreditProof(request, request.hubEntityId, now, creditDifficulty(usd))) throw new Error('INVALID_PROOF');
    if (this.busy) throw new Error('OFFICER_BUSY');
    this.busy = true;
    try {
      const evidence = await readCreditEvidence(adapter, request, now, this.ledger);
      const spent = this.ledger.spent(request);
      const score = scoreCredit(request, { ...evidence.facts, exposureUsd: evidence.facts.exposureUsd + spent }, spent);
      const audit = { request, now, ...evidence, score };
      this.ledger.record(request, usd, score.approved, audit, score.limitUsd - evidence.facts.exposureUsd);
      this.ledger.audit({ creditOfficer: 'decision', ...audit });
      if (!score.approved) return { success: true, approved: false, reason: score.reason };
      if (!adapter.commandReady || adapter.nextCommandSequence === null) throw new Error('HUB_COMMAND_UNAVAILABLE');
      const expiresAt = Math.min(evidence.terms.expiresAt, Date.parse(`${request.day}T00:00:00Z`) + 86_400_000);
      const data = {
        borrowerEntityId: request.borrowerEntityId,
        tokenId: request.tokenId,
        termId: request.termId,
        maxPrincipal: BigInt(request.amount),
        expiresAt,
      };
      const commandId = `credit-${Buffer.from(proofDigest(request)).toString('hex')}`;
      await adapter.send(
        {
          runtimeTxs: [],
          entityInputs: [
            {
              entityId: request.hubEntityId,
              signerId: evidence.signerId,
              entityTxs: [{ type: 'lendingApprove', data }],
            },
          ],
        },
        { commandId, commandSequence: adapter.nextCommandSequence },
      );
      this.ledger.audit({ creditOfficer: 'submitted', request, commandId, expiresAt });
      return { success: true, approved: true, reason: 'APPROVAL_SUBMITTED', expiresAt, commandId };
    } finally {
      this.busy = false;
    }
  }
}
