import type { LoadIdentity } from '../boundary/worker-boundary';
import type { LaneRuntime } from '../lanes/lane-runtimes';
import { decodeSettlementEvidenceResponse } from '../../../../api/runtime-adapter/control/settlement-evidence';
import {
  sendObserved,
  type ConnectedRuntime,
} from '../worker-runtime';

const COLLATERAL_EVIDENCE_AMOUNT = 1_000_000n;
const COLLATERAL_EVIDENCE_TIMEOUT_MS = 10_000;

export const hltAuthorityEvidenceEnabled = (): boolean => {
  const value = String(process.env['XLN_HLT_AUTHORITY_EVIDENCE'] ?? '').trim();
  if (!value) return false;
  if (value !== '1') throw new Error(`HLT_AUTHORITY_EVIDENCE_FLAG_INVALID:${value}`);
  return true;
};

export const materializeH1CollateralEvidence = async (options: Readonly<{
  hub: ConnectedRuntime;
  hubIdentity: LoadIdentity;
  lane: LaneRuntime;
}>): Promise<void> => {
  const { hub, hubIdentity, lane } = options;
  const readAccountHeight = async (): Promise<number> => {
    const evidence = decodeSettlementEvidenceResponse(await hub.adapter.control<unknown>({
      type: 'settlement-evidence',
      book: null,
      accounts: [{
        entityId: hubIdentity.entityId,
        counterpartyEntityId: lane.identity.entityId,
        offerIds: [],
      }],
    }));
    const account = evidence.accounts[0];
    if (!account) throw new Error('HLT_AUTHORITY_COLLATERAL_ACCOUNT_EVIDENCE_MISSING');
    return account.currentHeight;
  };
  const baselineHeight = await readAccountHeight();
  await sendObserved(hub, 'hlt-authority-evidence-r2c', {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hubIdentity.entityId,
      signerId: hubIdentity.signerId,
      entityTxs: [{
        type: 'r2c',
        data: {
          counterpartyId: lane.identity.entityId,
          tokenId: 1,
          amount: COLLATERAL_EVIDENCE_AMOUNT,
        },
      }],
    }],
  });
  await sendObserved(hub, 'hlt-authority-evidence-j-broadcast', {
    runtimeTxs: [],
    entityInputs: [{
      entityId: hubIdentity.entityId,
      signerId: hubIdentity.signerId,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }],
  });
  const deadline = Date.now() + COLLATERAL_EVIDENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const accountHeight = await readAccountHeight();
    if (accountHeight > baselineHeight) {
      console.log(
        `HLT_AUTHORITY_COLLATERAL_EVIDENCE_OK account=${lane.identity.entityId} ` +
        `amount=${COLLATERAL_EVIDENCE_AMOUNT} accountHeight=${accountHeight}`,
      );
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`HLT_AUTHORITY_COLLATERAL_EVIDENCE_TIMEOUT:${lane.identity.entityId}`);
};
