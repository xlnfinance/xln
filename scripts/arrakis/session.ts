import { createEmptyEnv } from '../../core/runtime';
import { deriveDelta } from '../../core/account/utils';
import { setScenarioStorageEnabled, findReplica } from '../../core/scenarios/harness/helpers';
import { formCompanyActors } from '../../core/scenarios/company-ipo/formation';
import { releaseCompanySharesToCustody } from '../../core/scenarios/company-ipo/custody';
import { prepareCompanyAccounts, proveOrdinaryCompanyPayment } from '../../core/scenarios/company-ipo/accounts';
import { openCompanyMarket, purchaseCompanyControl, runCompanyBuyback } from '../../core/scenarios/company-ipo/trading';
import {
  activateInvestorBoardAndHandover,
  proposeInvestorBoard,
  proveSuccessorReserveControl,
  settleInvestorControlReserve,
} from '../../core/scenarios/company-ipo/takeover';
import type { CompanyScenarioActors, CompanyShareTokens } from '../../core/scenarios/company-ipo/model';
import { deploySpice } from './spice';

export const steps = ['launch', 'pay', 'buy', 'settle', 'propose', 'activate', 'treasury', 'sell'] as const;
type Step = (typeof steps)[number];

/** Interactive orchestration only. Balances, trades and authority come from RJEA and EVM. */
export class ArrakisSession {
  private readonly env = createEmptyEnv(`arrakis:${crypto.randomUUID()}`, 6);
  private actors: CompanyScenarioActors | null = null;
  private shares: CompanyShareTokens | null = null;
  private nextBoard: Awaited<ReturnType<typeof proposeInvestorBoard>> | null = null;
  private completed: Step[] = [];
  private busy: Step | null = null;
  private failure: string | null = null;

  constructor() {
    this.env.scenarioMode = true;
    this.env.state.timestamp = 1;
    setScenarioStorageEnabled(this.env, false);
  }

  async act(step: Step): Promise<void> {
    // A response retry or double click must never repeat an accepted trade.
    if (this.completed.includes(step)) return;
    if (this.failure) throw new Error(this.failure);
    if (this.busy || step !== steps[this.completed.length]) throw new Error('ARRAKIS_STEP_OUT_OF_ORDER');
    this.busy = step;
    try {
      await this.execute(step);
      this.completed.push(step);
    } catch (error) {
      // Partial execution is not safe to retry. Keep the observable state and stop.
      this.failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.busy = null;
    }
  }

  private async execute(step: Step): Promise<void> {
    if (step === 'launch') {
      const actors = await formCompanyActors(this.env);
      this.actors = { ...actors, currency: { tokenId: await deploySpice(actors.jadapter), symbol: 'SPICE' } };
      this.shares = await releaseCompanySharesToCustody(this.env, this.actors, this.actors.boardCompany);
      await prepareCompanyAccounts(this.env, this.actors, this.shares);
      await openCompanyMarket(this.env, this.actors, this.shares);
      return;
    }
    const actors = this.actors,
      shares = this.shares;
    if (!actors || !shares) throw new Error('ARRAKIS_NOT_READY');
    if (step === 'pay') await proveOrdinaryCompanyPayment(this.env, actors);
    if (step === 'buy') await purchaseCompanyControl(this.env, actors, shares);
    if (step === 'settle') await settleInvestorControlReserve(this.env, actors, shares);
    if (step === 'propose') this.nextBoard = await proposeInvestorBoard(this.env, actors);
    if (step === 'activate') {
      if (!this.nextBoard) throw new Error('ARRAKIS_BOARD_NOT_PROPOSED');
      await activateInvestorBoardAndHandover(this.env, actors, this.nextBoard);
      this.actors = {
        ...actors,
        boardCompany: {
          ...actors.boardCompany,
          validators: [...this.nextBoard.config.validators],
          config: this.nextBoard.config,
        },
      };
    }
    if (step === 'treasury') await proveSuccessorReserveControl(this.env, actors, shares);
    if (step === 'sell') await runCompanyBuyback(this.env, actors, shares);
  }

  async close(): Promise<void> {
    if (this.busy) throw new Error('ARRAKIS_OPERATION_IN_PROGRESS');
    if (this.actors) await this.actors.jadapter.close();
  }

  snapshot() {
    const actors = this.actors,
      shares = this.shares;
    const balances = (entityId: string) => {
      const state = findReplica(this.env, entityId)[1].state;
      if (!actors || !shares) throw new Error('ARRAKIS_NOT_READY');
      const ids = [actors.currency.tokenId, shares.controlTokenId, shares.dividendTokenId];
      return ids.map(tokenId => {
        let secured = 0n,
          receivable = 0n,
          debt = 0n;
        for (const account of state.accounts.values()) {
          const delta = account.state.deltas.get(tokenId);
          if (!delta) continue;
          const view = deriveDelta(delta, account.state.leftEntity === entityId);
          secured += view.outCollateral;
          receivable += view.outPeerCredit;
          debt += view.inOwnCredit;
        }
        const reserve = state.reserves.get(tokenId) ?? 0n;
        return {
          tokenId,
          reserve: String(reserve),
          secured: String(secured),
          receivable: String(receivable),
          debt: String(debt),
          net: String(reserve + secured + receivable - debt),
        };
      });
    };
    return {
      completed: [...this.completed],
      next: steps[this.completed.length] ?? null,
      busy: this.busy,
      error: this.failure,
      height: this.env.state.height,
      runtimeId: this.env.runtimeId,
      tokens:
        actors && shares
          ? [
              { id: actors.currency.tokenId, symbol: 'SPICE', decimals: 6 },
              { id: shares.controlTokenId, symbol: 'SIR.CONTROL', decimals: 0 },
              { id: shares.dividendTokenId, symbol: 'SIR.DIVIDEND', decimals: 0 },
            ]
          : [],
      entities:
        actors && shares
          ? [
              ['investor', 'You · House Meridian', actors.investor],
              ['company', 'Sirocco Harvesting', actors.boardCompany],
              ['courier', 'Caravan Logistics', actors.soloCompany],
              ['market', 'Arrakis Exchange', actors.hub],
            ].map(([role, name, actor]) => {
              const entity = actor as CompanyScenarioActors['hub'];
              const state = findReplica(this.env, entity.id)[1].state;
              return {
                role,
                name,
                id: entity.id,
                height: state.height,
                threshold: String(state.config.threshold),
                validators: [...state.config.validators],
                balances: balances(entity.id),
              };
            })
          : [],
    };
  }
}
