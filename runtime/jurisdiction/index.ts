/**
 * Jurisdiction Module - Unified interface for blockchain jurisdictions
 *
 * Usage:
 *   import { getJurisdiction } from '@xln/runtime/jurisdiction';
 *
 *   // Browser (simnet)
 *   const j = await getJurisdiction({ type: 'browser', chainId: 1337 });
 *
 *   // Mainnet (Base)
 *   const j = await getJurisdiction({
 *     type: 'rpc',
 *     chainId: 8453,
 *     rpcUrl: 'https://mainnet.base.org',
 *     depositoryAddress: '0x...',
 *     entityProviderAddress: '0x...',
 *   });
 *
 *   // Same interface for both:
 *   const balance = await j.getReserves(entityId, tokenId);
 *   await j.deposit(privateKey, entityId, tokenId, amount);
 */

export type {
  IJurisdiction,
  JurisdictionConfig,
  Token,
  EntityInfo,
  TxReceipt,
} from './interface.js';

export {
  getJurisdiction,
  getCachedJurisdiction,
  clearJurisdictions,
  listJurisdictions,
} from './interface.js';

export { BrowserJurisdiction } from './browser-jurisdiction.js';
export { RpcJurisdiction } from './rpc-jurisdiction.js';
