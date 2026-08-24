export type RcpanSystemId = 'xln' | 'channels' | 'rollups' | 'tradfi';

export type RcpanComparisonCell = Readonly<{ lead: string; detail: string }>;
export type RcpanComparisonSystem = Readonly<{
  id: RcpanSystemId;
  name: string;
  caption: string;
}>;
export type RcpanComparisonRow = Readonly<{
  label: string;
  cells: Readonly<Record<RcpanSystemId, RcpanComparisonCell>>;
}>;

export const RCPAN_UPGRADES = [
  ['01', 'Portable proof', 'Both sides sign the same balance.'],
  ['02', 'Visible protection', 'Collateral, then reserve, then explicit debt.'],
  ['03', 'Executable dispute', 'Code allocates collateral, reserve, and explicit debt.'],
] as const;

export const RCPAN_SYSTEMS: readonly RcpanComparisonSystem[] = [
  { id: 'xln', name: 'xln', caption: 'Provable bilateral credit' },
  { id: 'channels', name: 'Lightning-style', caption: 'Full-reserve channels' },
  { id: 'rollups', name: 'EVM rollups', caption: 'Shared ordered state' },
  { id: 'tradfi', name: 'TradFi / RTGS', caption: 'Operator-led settlement' },
] as const;

export const RCPAN_COMPARISON_ROWS: readonly RcpanComparisonRow[] = [
  {
    label: 'Everyday update',
    cells: {
      xln: { lead: 'Two parties sign', detail: 'The account updates between its participants.' },
      channels: { lead: 'Two parties sign', detail: 'The channel updates between its participants.' },
      rollups: { lead: 'A sequencer orders it', detail: 'The transaction joins shared L2 state.' },
      tradfi: { lead: 'The operator records it', detail: 'The institution controls its internal ledger.' },
    },
  },
  {
    label: 'Credit and collateral',
    cells: {
      xln: { lead: 'Choose the mix', detail: 'Combine per-account credit with shared collateral.' },
      channels: { lead: 'Reserve first', detail: 'Capacity comes from funds locked in the channel.' },
      rollups: { lead: 'Application-specific', detail: 'Credit belongs to a separate contract or product.' },
      tradfi: { lead: 'Institution-defined', detail: 'Limits depend on the operator and its balance sheet.' },
    },
  },
  {
    label: 'Evidence you keep',
    cells: {
      xln: { lead: 'Co-signed account proof', detail: 'Both sides hold the latest agreed account state.' },
      channels: { lead: 'Channel commitment', detail: 'The latest channel state can close on-chain.' },
      rollups: { lead: 'Shared state proof', detail: 'Exit follows the rollup data and proof rules.' },
      tradfi: { lead: 'Statement and law', detail: 'No bilateral crypto receipt in the FCUAN baseline.' },
    },
  },
  {
    label: 'Where rules run',
    cells: {
      xln: { lead: 'Account first, EVM on dispute', detail: 'Fast updates stay bilateral; code settles conflict.' },
      channels: { lead: 'Channel close logic', detail: 'HTLC and close rules settle locked funds.' },
      rollups: { lead: 'Shared EVM execution', detail: 'Transactions execute inside common L2 state.' },
      tradfi: { lead: 'Outside the RTGS rail', detail: 'Institutions and courts handle account disputes.' },
    },
  },
  {
    label: 'When cooperation stops',
    cells: {
      xln: { lead: 'Settle this account', detail: 'Proof allocates collateral to reserves; shortfall becomes debt.' },
      channels: { lead: 'Close this channel', detail: 'Locked funds follow the channel close rules.' },
      rollups: { lead: 'Use the L2 exit path', detail: 'Finality and withdrawal follow rollup and bridge rules.' },
      tradfi: { lead: 'Enter a legal process', detail: 'No code-enforced bilateral payout exists.' },
    },
  },
  {
    label: 'Honest tradeoff',
    cells: {
      xln: { lead: 'Keep proof; choose exposure', detail: 'Credit above collateral remains counterparty risk.' },
      channels: { lead: 'Lock liquidity', detail: 'Receiving depends on available inbound balance.' },
      rollups: { lead: 'Share ordering and data', detail: 'Users rely on common availability rules.' },
      tradfi: { lead: 'Trust the operator', detail: 'Users rely on its records, controls, and reconciliation.' },
    },
  },
] as const;
