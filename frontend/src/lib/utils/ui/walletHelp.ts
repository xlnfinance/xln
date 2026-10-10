/** Shared UI copy: the two wallets teach the same financial concepts. */
export const walletHelp: Record<string, string> = {
  pay: 'Send a payment through your connected accounts. Available capacity includes credit offered by your counterparty; credit is not part of your balance.',
  send: 'Send a payment through your connected accounts. Available capacity includes credit offered by your counterparty; credit is not part of your balance.',
  receive: 'Share a payment request or QR code. Incoming capacity is how much your accounts can receive now.',
  swap: 'Exchange assets at your chosen minimum rate. An unmatched order stays open and reserves funds until it fills or you cancel it.',
  move: 'Move funds between your external wallet, the XLN contract reserve and account collateral. On-chain steps require gas and confirmation.',
  lending: 'A deposit moves your money into a claim on the hub. Example: from 100 USDC, lend 20; 80 stays in your account and 20 is in lending. Borrowing transfers the loan amount once and creates a repayment obligation. Review the repayment amount and date before submitting.',
  lendingBalance: 'Example: you have 100 USDC and lend 20. Your total is still 100: 80 in your account + 20 in lending. The deposit is not available for payments until returned. It includes principal allocated to borrowers and interest already received, but not promised future interest. Positions are reported by the hub, not independently verified by this wallet; their value depends on the hub paying you back. A loan adds money to your account but its unpaid repayment amount is deducted from your total. Example: borrow 20 at 1% for the term; your account gains 20 and you owe 20.20, so your net total falls by 0.20. Unused credit is not money.',
  history: 'Review payments, swaps and settlements, including amounts, fees and their current status.',
  activity: 'Inspect runtime and account events to understand pending work and diagnose failures.',
  configure: 'Change credit limits, rebalance settings and dispute controls. Credit you extend is the unsecured exposure you accept to this counterparty.',
  open: 'Connect to a hub or another wallet. An account is a bilateral payment connection with its own balance, limits and signed history.',
  appearance: 'Adjust how account balances and capacity are displayed. These settings do not change your funds or credit limits.',
  assets: 'View tokens held in your external wallet, contract reserve and bilateral accounts. Pending deposits become usable after confirmation.',
  ownership: 'Inspect the entity’s owners, voting power and control. Ownership changes affect who can authorize its actions.',
  protection: 'Keep encrypted backups and appoint dispute protection. Configuration alone is not protection: check the latest backup receipt and the tower’s response status.',
  balance: 'Total balance includes external funds, reserves, signed account balances and hub-reported lending deposits. Frozen funds remain yours; drawn account debt is deducted. Example: 80 USDC in your account + 20 in lending = 100 total. Available to pay excludes lending deposits and includes unused credit; a 50 USDC credit limit does not make you 50 USDC richer. Unpaid term loans, including agreed interest, are also deducted; their schedules are shown in Lending. USD values use reference prices, not executable swap quotes.',
};
