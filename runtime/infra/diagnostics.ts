import { isBrowser } from './platform-crypto';

const createDebug = (namespace: string) => {
  const enabled = ['state', 'tx', 'block', 'error', 'diff', 'info']
    .some(fragment => namespace.includes(fragment));
  return enabled ? console.log.bind(console, `[${namespace}]`) : () => {};
};

// `debug` is a process dependency; browser builds use the equivalent local
// logger and therefore never pull Node module loading into the bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const debug = isBrowser ? createDebug : require('debug');

export const log = {
  state: debug('state:🔵'),
  tx: debug('tx:🟡'),
  block: debug('block:🟢'),
  error: debug('error:🔴'),
  diff: debug('diff:🟣'),
  info: debug('info:ℹ️'),
};
