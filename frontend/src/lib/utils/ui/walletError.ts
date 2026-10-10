const explanations: Array<[string, string]> = [
  ['ACCOUNT_DISPUTE_GAS_BUDGET_EXCEEDED', 'This account has reached its dispute gas budget. Wait for pending payments to finish or close swap orders before adding more obligations, or use another account. The limit keeps newly signed proofs within the 5 million gas budget.'],
  ['BRAINVAULT_WORKER_LOAD_FAILED', 'The browser could not start key derivation. Check that the wallet server is running, then reload the page and retry.'],
  ['OWNER_RUNTIME_MISMATCH', 'These endpoints belong to different runtimes. Select a destination offered by the same hub operator.'],
  ['ACCOUNT_FROZEN', 'This account is frozen for a dispute. Use another active account or open Manage to follow the dispute.'],
  ['RECEIVE_CAPACITY_ACCOUNT_MISSING', 'The receiving account is not ready yet. Check the destination hub connection before retrying.'],
  ['SETTLEMENT_PROJECTED_COLLATERAL_RANGE', 'The requested withdrawal exceeds account collateral. Credit cannot be withdrawn as collateral. Reduce the amount.'],
  ['FAUCET_JURISDICTION_UNAVAILABLE', 'The test-money service cannot reach the selected network. Reconnect that network and retry.'],
  ['FAUCET_WALLET_ETH_UNDERFUNDED', 'The test-money service has run out of gas on this network. Its operator must refill it before this request can succeed.'],
  ['FAUCET_WALLET_TOKEN_UNDERFUNDED', 'The test-money service does not have enough of this token. Its operator must refill it before this request can succeed.'],
  ['PUSH_TOKEN_PROVIDER_UNAVAILABLE', 'This browser cannot register push notifications. Keep the wallet online or use a supported device.'],
  ['TOWER_BUNDLE_NOT_FOUND', 'No encrypted backup was found on this tower. Check the tower address or import your saved backup.'],
  ['Failed to fetch', 'The service could not be reached. Check your connection and whether the local stack is running.'],
];

/** Keep the complete diagnostic visible; never replace it with a generic success or hide it in a disclosure. */
export function explainWalletError(message: string): string {
  const match = explanations.find(([code]) => message.includes(code));
  return match && !message.includes(match[1]) ? `${match[1]}\n${message}` : message;
}
