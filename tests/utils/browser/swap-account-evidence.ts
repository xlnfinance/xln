import type { Page } from '../../global-setup.mts';
import type { RuntimeReplica, XLNModule, RuntimeAdapterViewFrame } from '../../../core/api/public/runtime-module';
import type { DebugWindow } from '../../../ui/tests/swap-evidence';

type Account = NonNullable<RuntimeAdapterViewFrame['activeEntity']>['accounts']['items'][number];
export const readAccountCommit = (page: Page, entityId: string, hubId: string) =>
  page.evaluate(
    async ids => {
      const adapter = (window as DebugWindow).__xln?.adapter();
      if (!adapter) throw new Error('SWAP_ADAPTER_MISSING');
      const account = await adapter.read<Account>(`entity/${ids.entityId}/account/${ids.hubId}`);
      const tokens = [1, 2].map(tokenId => {
        const delta = account.state.deltas.get(tokenId);
        if (!delta) throw new Error(`SWAP_DELTA_MISSING:${tokenId}`);
        return {
          tokenId,
          hasDelta: true,
          delta: {
            collateral: String(delta.collateral),
            ondelta: String(delta.ondelta),
            offdelta: String(delta.offdelta),
            leftCreditLimit: String(delta.leftCreditLimit),
            rightCreditLimit: String(delta.rightCreditLimit),
            leftHold: String(delta.leftHold),
            rightHold: String(delta.rightHold),
          },
        };
      });
      return {
        currentHeight: account.currentHeight,
        accountStateRoot: account.currentFrame.accountStateRoot,
        pendingFrameHeight: account.pendingFrame?.height ?? null,
        mempool: account.mempoolCount,
        tokens,
      };
    },
    { entityId, hubId },
  );

export const readCollateralPolicy = (page: Page, entityId: string, hubId: string, tokenId: number) =>
  page.evaluate(
    async ids => {
      const debug = (window as DebugWindow).__xln;
      const adapter = debug?.adapter();
      if (!debug || !adapter) throw new Error('COLLATERAL_POLICY_ADAPTER_MISSING');
      const account = await adapter.read<Account>(`entity/${ids.entityId}/account/${ids.hubId}`);
      const xln = await debug.xln();
      return (
        account.state.rebalanceFeePolicies?.get(ids.tokenId)?.[
          xln.isLeftEntity(ids.entityId, ids.hubId) ? 'right' : 'left'
        ] ?? null
      );
    },
    { entityId, hubId, tokenId },
  );

export const readCollateralFees = (
  page: Page,
  entityId: string,
  hubId: string,
  beforeHeight: number,
  afterHeight: number,
) =>
  page.evaluate(
    async ids => {
      const debug = (window as Window & { __xln?: { env(): RuntimeReplica | null; xln(): Promise<XLNModule> } }).__xln;
      const env = debug?.env();
      if (!debug || !env) throw new Error('COLLATERAL_FEE_RUNTIME_MISSING');
      const frames = await (
        await debug.xln()
      ).readPersistedAccountFrameHistory(env, ids.entityId, ids.hubId, ids.afterHeight, {
        maxAccountHeight: ids.afterHeight,
      });
      return frames
        .filter(frame => frame.height > ids.beforeHeight)
        .flatMap(frame =>
          frame.accountTxs
            .filter(tx => tx.type === 'request_collateral')
            .map(tx => ({
              height: frame.height,
              stateHash: frame.stateHash,
              root: frame.accountStateRoot,
              tokenId: tx.data.tokenId,
              feeTokenId: tx.data.feeTokenId ?? tx.data.tokenId,
              amount: tx.data.amount,
              fee: tx.data.feeAmount,
              policyVersion: tx.data.policyVersion,
            })),
        );
    },
    { entityId, hubId, beforeHeight, afterHeight },
  );
