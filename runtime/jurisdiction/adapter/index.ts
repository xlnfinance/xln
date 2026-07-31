/**
 * Public JAdapter surface.
 *
 * Internal modules import their concrete owner instead of this facade. Keeping
 * the facade dependency-free prevents the adapter factory, Jurisdiction
 * helpers, and Runtime API from forming a circular initialization graph.
 */
export * from './types';
export * from './browservm-registry';
export * from './chain-ids';
export * from './factory';
export * from './jurisdiction';
export { debugFundReserves, getEntityInfoFromChain, submitProcessBatch } from './runtime-api';
