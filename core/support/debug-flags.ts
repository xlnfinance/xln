/**
 * Process-wide diagnostic switches.
 *
 * These flags belong to infrastructure rather than any state machine. Keeping
 * them in a dependency-free module prevents core modules from importing the
 * root utility barrel merely to decide whether to emit diagnostic logs.
 */
const envFlag = (name: string): boolean => {
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.[name] === '1';
  } catch {
    return false;
  }
};

export const DEBUG = envFlag('XLN_DEBUG_LOGS');
// Receiver-side consensus logs (frame.accept, ack application) are the only
// witnesses to a lost bilateral ACK; an operator may enable them for one HLT
// run instead of re-running blind.
export const HEAVY_LOGS = envFlag('XLN_HEAVY_LOGS');
