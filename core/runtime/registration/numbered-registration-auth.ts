import type { RuntimeTx } from '../types';

type RegistrationRuntimeTx = Extract<
  RuntimeTx,
  { type: 'recordNumberedRegistrationIntent' | 'resolveNumberedRegistrationIntent' }
>;

const LOCAL_NUMBERED_REGISTRATION = Symbol('xln.local-numbered-registration');

export const markLocalNumberedRegistrationTx = <T extends RegistrationRuntimeTx>(tx: T): T => {
  Object.defineProperty(tx, LOCAL_NUMBERED_REGISTRATION, { value: true });
  return tx;
};

export const markRestoredNumberedRegistrationTxs = (runtimeTxs: RuntimeTx[]): void => {
  for (const tx of runtimeTxs) {
    if (tx.type === 'recordNumberedRegistrationIntent' || tx.type === 'resolveNumberedRegistrationIntent') {
      markLocalNumberedRegistrationTx(tx);
    }
  }
};

export const assertNumberedRegistrationTxAuthorized = (
  tx: RuntimeTx,
  replay: boolean,
): void => {
  if (tx.type !== 'recordNumberedRegistrationIntent' && tx.type !== 'resolveNumberedRegistrationIntent') {
    return;
  }
  if (
    replay ||
    (tx as RegistrationRuntimeTx & { [LOCAL_NUMBERED_REGISTRATION]?: boolean })[
      LOCAL_NUMBERED_REGISTRATION
    ] === true
  ) {
    return;
  }
  throw new Error('NUMBERED_REGISTRATION_EXTERNAL_RUNTIME_TX_REJECTED');
};
