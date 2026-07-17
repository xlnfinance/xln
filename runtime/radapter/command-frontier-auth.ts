import type { RuntimeTx } from '../types';

type CommandMarkerTx = Extract<RuntimeTx, { type: 'recordRuntimeAdapterCommand' }>;
const LOCAL_RUNTIME_ADAPTER_COMMAND = Symbol('xln.local-runtime-adapter-command');

export const markLocalRuntimeAdapterCommandTx = <T extends CommandMarkerTx>(tx: T): T => {
  Object.defineProperty(tx, LOCAL_RUNTIME_ADAPTER_COMMAND, { value: true });
  return tx;
};

export const copyLocalRuntimeAdapterCommandAuthorization = (
  source: RuntimeTx,
  target: RuntimeTx,
): void => {
  if (
    source.type === 'recordRuntimeAdapterCommand'
    && target.type === 'recordRuntimeAdapterCommand'
    && (source as CommandMarkerTx & { [LOCAL_RUNTIME_ADAPTER_COMMAND]?: boolean })[
      LOCAL_RUNTIME_ADAPTER_COMMAND
    ] === true
  ) markLocalRuntimeAdapterCommandTx(target);
};

export const assertRuntimeAdapterCommandTxAuthorized = (
  tx: RuntimeTx,
  replay: boolean,
): void => {
  if (tx.type !== 'recordRuntimeAdapterCommand') return;
  if (
    replay
    || (tx as CommandMarkerTx & { [LOCAL_RUNTIME_ADAPTER_COMMAND]?: boolean })[
      LOCAL_RUNTIME_ADAPTER_COMMAND
    ] === true
  ) return;
  throw new Error('RADAPTER_COMMAND_RUNTIME_TX_UNAUTHORIZED');
};
