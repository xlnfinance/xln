/**
 * Full deterministic company lifecycle: numbered formation, 1-of-1 and 2-of-3
 * governance, two ERC1155 share classes in custody, ordinary payments, IPO
 * trades, and buyback. Board authority remains Hanko-only and never a token.
 */

import type { RuntimeReplica } from '../../runtime/types';
import { enableStrictScenario } from '../harness/helpers';
import { requireReplica } from '../consensus/multi-sig';
import { prepareCompanyAccounts, proveOrdinaryCompanyPayment } from './accounts';
import { releaseCompanySharesToCustody } from './custody';
import { formCompanyActors } from './formation';
import { runCompanyBuyback, runCompanyMarket } from './trading';
import {
  activateInvestorBoardAndHandover,
  proveSuccessorReserveControl,
  proposeInvestorBoard,
  settleInvestorControlReserve,
} from './takeover';

const assertBoardThresholdEvidence = (
  env: RuntimeReplica,
  entityId: string,
  validators: string[],
): void => {
  for (const validator of validators) {
    const proposals = [...requireReplica(env, entityId, validator).state.proposals.values()];
    const executed = proposals.filter(proposal => proposal.status === 'executed');
    if (executed.length === 0 || executed.some(proposal => proposal.votes.size < 2)) {
      throw new Error(`COMPANY_BOARD_THRESHOLD_EVIDENCE_MISSING:${entityId}:${validator}`);
    }
  }
};

export async function companyIpo(env: RuntimeReplica): Promise<RuntimeReplica> {
  const restoreStrict = enableStrictScenario(env, 'Company IPO');
  const previousScenarioMode = env.scenarioMode;
  try {
    env.scenarioMode = true;
    if (env.state.height === 0) env.state.timestamp = 1;
    console.log('=== COMPANY IPO: FORMATION → CUSTODY → MARKET → BUYBACK ===');
    const actors = await formCompanyActors(env);
    const shares = await releaseCompanySharesToCustody(env, actors, actors.boardCompany);
    await prepareCompanyAccounts(env, actors, shares);
    await proveOrdinaryCompanyPayment(env, actors);
    await runCompanyMarket(env, actors, shares);
    assertBoardThresholdEvidence(env, actors.boardCompany.id, actors.boardCompany.validators);
    await settleInvestorControlReserve(env, actors, shares);
    const investorBoard = await proposeInvestorBoard(env, actors);
    await activateInvestorBoardAndHandover(env, actors, investorBoard);
    const postTakeoverActors = {
      ...actors,
      boardCompany: {
        ...actors.boardCompany,
        validators: [...investorBoard.config.validators],
        config: investorBoard.config,
      },
    };
    await proveSuccessorReserveControl(env, postTakeoverActors, shares);
    await runCompanyBuyback(env, postTakeoverActors, shares);
    console.log('COMPANY_IPO_PASS: 1-of-1 + 2-of-3 + CONTROL/DIVIDEND + settled takeover/handover + successor reserve control + buyback');
    return env;
  } finally {
    env.scenarioMode = previousScenarioMode ?? false;
    restoreStrict();
  }
}

if (import.meta.main) {
  const { createEmptyEnv } = await import('../../runtime');
  await companyIpo(createEmptyEnv('company-ipo-scenario'));
}
