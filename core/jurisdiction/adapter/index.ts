/**
 * Public JAdapter surface.
 *
 * Internal modules import their concrete owner instead of this facade. Keeping
 * the facade dependency-free prevents the adapter factory, Jurisdiction
 * helpers, and Runtime API from forming a circular initialization graph.
 */
export * from './types';
export * from './browservm/browservm-registry';
export * from './chain-ids';
export * from './kernel/factory';
export * from './kernel/jurisdiction';
export { debugFundReserves, getEntityInfoFromChain, submitProcessBatch } from './kernel/runtime-api';
