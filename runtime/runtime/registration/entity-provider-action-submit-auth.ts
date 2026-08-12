import type { RuntimeTx } from '../types';

type RetryActionTx = Extract<RuntimeTx, { type: 'retryEntityProviderAction' }>;
type RecordActionResultTx = Extract<RuntimeTx, { type: 'recordEntityProviderActionSubmitResult' }>;
const LOCAL_ACTION_SUBMIT_RUNTIME_TX = Symbol.for('xln.runtime.entity-provider-action-submit.local');

export const markLocalEntityProviderActionRuntimeTx = <T extends RetryActionTx | RecordActionResultTx>(
  tx: T,
): T => {
  Object.defineProperty(tx, LOCAL_ACTION_SUBMIT_RUNTIME_TX, { value: true, enumerable: false });
  return tx;
};

export const copyLocalEntityProviderActionRuntimeTxAuthorization = (
  source: RuntimeTx,
  target: RuntimeTx,
): void => {
  if (
    (source.type === 'retryEntityProviderAction' || source.type === 'recordEntityProviderActionSubmitResult') &&
    source.type === target.type &&
    (source as RuntimeTx & { [LOCAL_ACTION_SUBMIT_RUNTIME_TX]?: boolean })[LOCAL_ACTION_SUBMIT_RUNTIME_TX]
  ) markLocalEntityProviderActionRuntimeTx(target as RetryActionTx | RecordActionResultTx);
};

export const markRestoredEntityProviderActionRuntimeTxs = (runtimeTxs: RuntimeTx[]): void => {
  for (const runtimeTx of runtimeTxs) {
    if (
      runtimeTx.type === 'retryEntityProviderAction' ||
      runtimeTx.type === 'recordEntityProviderActionSubmitResult'
    ) markLocalEntityProviderActionRuntimeTx(runtimeTx);
  }
};

export const assertEntityProviderActionRuntimeTxAuthorized = (
  runtimeTx: RuntimeTx,
  replay: boolean,
): void => {
  if (
    runtimeTx.type !== 'retryEntityProviderAction' &&
    runtimeTx.type !== 'recordEntityProviderActionSubmitResult'
  ) return;
  if (
    replay ||
    (runtimeTx as RuntimeTx & { [LOCAL_ACTION_SUBMIT_RUNTIME_TX]?: boolean })[LOCAL_ACTION_SUBMIT_RUNTIME_TX]
  ) return;
  throw new Error('ENTITY_PROVIDER_ACTION_RUNTIME_TX_EXTERNAL_INGRESS_REJECTED');
};
