/**
 * Process-wide diagnostic switches.
 *
 * These flags belong to infrastructure rather than any state machine. Keeping
 * them in a dependency-free module prevents core modules from importing the
 * root utility barrel merely to decide whether to emit diagnostic logs.
 */
export const DEBUG = false;
export const HEAVY_LOGS = false;
