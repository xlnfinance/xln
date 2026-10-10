/** Shared teaching content. Navigation and observation stay with each UI; lessons never sign transactions. */
export const WALLET_LESSONS = [
  {
    id: 'faucet',
    prerequisite: 'Use a disposable test wallet with an accepted hub connection.',
    value: 'Try the whole journey: pay, trade and create a company with test money.',
    outcome: 'Your balance increases by 100 USDC. These demo funds have no real value.',
    title: 'Get test money',
    route: 'assets',
    example:
      'Use test money in a disposable wallet. A faucet payment is a hub promise, not a bank deposit. Total balance and available-to-send can differ.',
    exercise: 'Request 100 test USDC and wait for the balance to arrive.',
  },
  {
    id: 'pay',
    prerequisite: 'Keep at least 25 USDC available. Choose H2 in the same jurisdiction.',
    value: 'Pay through signed accounts, without a blockchain transaction for every payment.',
    outcome: 'The receipt says Paid, shows 25 USDC and identifies H2. Your balance reflects the payment and any fee.',
    title: 'Send a payment',
    route: 'accounts/send',
    example:
      'Sending 25 USDC from 100 leaves 75 before fees. Check the recipient, asset, amount and route fee before signing.',
    exercise: 'Pay 25 USDC to H2, then open the confirmed receipt. A submitted payment is not yet a received payment.',
  },
  {
    id: 'trade',
    prerequisite: 'Keep at least 25 USDC available and use a hub with a live orderbook.',
    value: 'Use the same account to exchange assets at a price you choose.',
    outcome:
      'A filled swap adds WETH. If it stays open, find the order below the form; you can cancel its unfilled amount.',
    title: 'Swap and manage orders',
    route: 'accounts/swap',
    example:
      'A limit order waits for a matching price. An open order is not a completed swap. Cancelling releases the unfilled part; a filled part remains yours.',
    exercise:
      'Try exchanging 25 USDC for WETH. Review the quoted receive amount and price before placing the order. Watch for WETH arriving; if unmatched, inspect the open order below the form.',
  },
  {
    id: 'history',
    prerequisite: 'Complete the payment and swap exercises, or inspect a clearly marked open order.',
    value: 'Check what actually happened to your money, instead of trusting a success animation.',
    outcome: 'Find your 25 USDC payment and your swap. Compare recipients, amounts, fees and final statuses.',
    title: 'Read your receipts',
    route: 'accounts/activity',
    example:
      'Activity tells you what happened, who received it and whether it settled. A transaction hash identifies evidence; it does not by itself prove success.',
    exercise: 'Open your payment and swap records. Compare the amounts and final statuses.',
  },
  {
    id: 'jurisdiction',
    prerequisite: 'Use the network banner on every screen; a network change does not transfer funds.',
    value: 'Choose which blockchain enforces your accounts and which contract stack you use.',
    outcome:
      'The banner, chain ID and contract addresses identify the selected entity’s jurisdiction and stack. Switching networks does not move money.',
    title: 'Know your jurisdiction',
    route: 'settings/stack-manager',
    example:
      'Ethereum, TRON and XLNC are different jurisdictions. Inside each, a stack identifies the Depository and Entity Provider contracts. Entity #1 in one provider is not Entity #1 everywhere.',
    exercise:
      'Read the network banner and expand Contract stack. Use the entity switcher to inspect another network; check the name and chain ID before moving money.',
  },
  {
    id: 'cross',
    prerequisite: 'Keep both network identities in this wallet, with accepted hub accounts and receiving capacity on the destination.',
    value: 'Exchange assets into your own account in another jurisdiction without giving a bridge custody of your wallet.',
    outcome: 'Verify the source debit AND destination credit. An open cross-network order is not delivered money.',
    title: 'Swap across networks',
    route: 'accounts/swap',
    example: 'Sending USDC on Testnet to receive an asset on Tron involves two different accounts. Check both network names, the minimum received and the matching venue. A quote for one network is not a quote for the other.',
    exercise: 'Choose the destination network, asset and matching hub. Enter a small amount and an explicit minimum to receive. Review the route, then submit. Stay online; inspect both legs and clear the order when needed. Cancel an unmatched remainder to release its reserved funds.',
  },
  {
    id: 'receive',
    prerequisite: 'Have a second funded test wallet and at least 5 USDC incoming capacity.',
    value: 'Ask someone to pay you with a link instead of explaining addresses and amounts.',
    outcome: 'Your request shows 5 USDC. Only an incoming receipt and an updated balance mean you have been paid.',
    title: 'Request a payment',
    route: 'accounts/receive',
    example:
      'An invoice asks for money; it does not receive money by itself. Incoming capacity determines how much your account can accept. Credit means trusting the counterparty.',
    exercise:
      'Make a 5 USDC request and copy the payment link. Pay it from a second test wallet, then check Activity for the incoming receipt.',
  },
  {
    id: 'hubs',
    prerequisite: 'Select your intended jurisdiction first. Connect only to a hub in that jurisdiction and stack.',
    value: 'Choose your payment connections and compare their terms.',
    outcome: 'The new hub appears as a connected account with agreed limits. A connection alone does not fund it.',
    title: 'Connect to a hub',
    route: 'accounts/open',
    example:
      'A hub routes payments. Check its jurisdiction, fees and collateral. Giving 100 USDC of credit means accepting up to 100 USDC of its unsecured promise.',
    exercise:
      'Open an account with another hub in the same jurisdiction. Review its terms and wait for the account to be accepted.',
  },
  {
    id: 'limits',
    prerequisite: 'Use an accepted account. Read the current limit and who will owe whom.',
    value: 'Decide how much you are willing to trust each counterparty.',
    outcome:
      'The signed account shows your new limit. Your balance does not increase just because you increased a limit.',
    title: 'Set credit limits',
    route: 'accounts/configure',
    example:
      'A credit limit is permission to owe, not a balance. Raising credit from 100 to 200 creates 100 of extra exposure; it does not create 100 of money.',
    exercise:
      'Select an account, inspect incoming and outgoing capacity, then change a small test credit limit. Wait for the signed account state to update.',
  },
  {
    id: 'move',
    prerequisite: 'Get test gas and reserve USDC from Assets. Credit from the Account faucet is not reserve money.',
    value: 'Choose where funds sit: your blockchain wallet, reserve or payment account.',
    outcome:
      'The confirmed account collateral increases by 5 USDC and reserve decreases accordingly. Check gas separately.',
    title: 'Move and settle money',
    route: 'accounts/move',
    example:
      'Wallet: tokens at your on-chain address. Reserve: tokens in the Depository. Account: your bilateral position with a counterparty. On-chain moves need gas and confirmation.',
    exercise:
      'Fund gas and a small reserve from the test faucets. Move 5 USDC from reserve to account collateral, then inspect the confirmed position. A queued batch is not final.',
  },
  {
    id: 'withdraw',
    prerequisite: 'Keep test gas and at least 5 USDC in reserve. If funds are on an account, settle collateral back to reserve first.',
    value: 'Return funds to a blockchain address you control.',
    outcome: 'The reserve falls by 5 USDC and the receiving blockchain wallet gains 5 USDC after confirmation.',
    title: 'Withdraw to your wallet',
    route: 'accounts/move',
    example: 'A hub promise is not a token in reserve. First obtain an agreed settlement, or enforce collateral through a dispute. Withdrawing your own reserve then pays tokens to the selected external address.',
    exercise: 'Choose Reserve → External, select USDC and your own address, enter 5, then review and broadcast. Wait for confirmation and check the external balance. Submitted is not confirmed.',
  },
  {
    id: 'lending',
    prerequisite: 'Keep 5 USDC spendable. A lending position is a claim against the hub, not guaranteed collateral.',
    value: 'Put funds to work or borrow against agreed terms, with the obligation visible.',
    outcome:
      'A 5 USDC deposit appears as a lending position; spendable funds fall by 5. Check when and how you can withdraw.',
    title: 'Lend and withdraw',
    route: 'accounts/lending',
    example:
      'Lending 5 USDC exchanges spendable money for a claim. It is still an asset, but it may not be immediately withdrawable. Borrowing adds both available funds and a debt.',
    exercise:
      'Lend 5 test USDC. Find the position below, read its rate and term, then request withdrawal. Check whether it closed or is waiting for outstanding loans to repay.',
  },
  {
    id: 'borrow',
    prerequisite: 'Use a funded test account and a hub with lending liquidity. Keep money available for repayment.',
    value: 'Borrow with the cost and repayment obligation visible before you commit.',
    outcome: 'An approved loan adds spendable funds AND a debt. A pending request has not paid you.',
    title: 'Borrow with a known cost',
    route: 'accounts/lending',
    example: 'At a maximum 1% per term, borrowing 2 USDC costs at most 0.02 USDC: maximum repayment 2.02. The matched rate may be lower. This is a rate for the selected term, not an annual rate.',
    exercise: 'Choose Borrow, enter 2 USDC, select a term and maximum rate. Read the maximum repayment and eligibility before submitting. Find the approved loan below, or inspect and cancel an unmatched request.',
  },
  {
    id: 'repay',
    prerequisite: 'Have an approved test loan and enough available funds for its full displayed repayment.',
    value: 'Close your obligation and understand the difference between principal and interest.',
    outcome: 'The loan closes, its debt disappears and the payment includes principal plus interest exactly once.',
    title: 'Repay a loan',
    route: 'accounts/lending',
    example: 'Repaying a 2 USDC loan at 1% uses 2.02 USDC. Borrowing never increased your net wealth: it created an equal obligation plus the financing cost.',
    exercise: 'Find your loan, check its amount due and choose Repay. Wait for the confirmed state, then verify the loan closed and balances changed. Revisit your lending position and withdraw any available funds.',
  },
  {
    id: 'protection',
    prerequisite: 'Keep your recovery secret private and use a reachable recovery service.',
    value: 'Keep the ability to recover and defend your money when your device is unavailable.',
    outcome:
      'Inspect the last successful backup and actual tower coverage. An enabled setting alone is not proof of protection.',
    title: 'Protect and recover',
    route: 'settings/recovery',
    example:
      'Your secret restores signing authority. A backup restores committed wallet state and signed proofs. A watchtower can answer an outdated dispute while you are offline. These solve different problems.',
    exercise:
      'Configure the backup service and wait for a successful upload receipt with a recent frame. Read backup and dispute coverage separately. Exported evidence alone is not a wallet backup.',
  },
  {
    id: 'recovery',
    prerequisite: 'First verify a fresh successful remote backup. Keep the original wallet intact and use a separate browser profile.',
    value: 'Prove that losing this device does not mean losing access to the backed-up wallet.',
    outcome: 'The restored wallet has the same identity, accounts and balance, and can send a small test payment.',
    title: 'Recover on a new device',
    route: 'settings/recovery',
    example: 'The same secret gives you the same signing key; it does not recreate balances from memory. You also need your encrypted backup and its signed account evidence.',
    exercise: 'In a clean browser profile, restore the original recovery phrase or derive the same BrainVault identity. Choose recovery from the same tower before fresh setup. Compare identity and balances, send 1 test USDC, then reload and verify it remains paid.',
  },
  {
    id: 'company',
    prerequisite: 'Get gas first. For shared approval, arrange the other signers before choosing a threshold.',
    value: 'Run a business or shared treasury with its own identity and approval rules.',
    outcome:
      'Your named company appears in the entity switcher with a registered ID. Its board shows exactly who can approve.',
    title: 'Create a company',
    route: 'ownership',
    example:
      'A company is an Entity with a board. With three equal signers and threshold 2, any two approve; one cannot. On-chain registration creates the numbered identity and share treasury.',
    exercise:
      'Open Assets → Gas faucet first. Return here and create a named, registered Entity; use Shared approval for a multisig board. Choose the jurisdiction and check signer addresses and threshold. Then select the new company.',
  },
  {
    id: 'shares',
    prerequisite: 'Select a registered company you control; a personal self-issued Entity has no share treasury.',
    value: 'Give your company on-chain ownership and dividend share classes.',
    outcome:
      'Both share classes appear in the company reserves after release. Supply is not a valuation or a promise of income.',
    title: 'Manage company shares',
    route: 'ownership',
    example:
      'CONTROL shares govern the board. DIVIDEND shares represent the dividend class. Creating shares does not create revenue or give them a market price.',
    exercise:
      'On the registered company, inspect the board, share supplies and treasury. Release treasury shares to the Depository, then verify the confirmed reserves before any allocation.',
  },
  {
    id: 'governance',
    prerequisite: 'Advanced exercise: an eligible disposable registered target, settled CONTROL majority, target state and authorized signer are required.',
    value: 'Understand how ownership can change who approves company actions.',
    outcome: 'Only confirmed activation changes the board. A proposal or a majority alone is not an activated handover.',
    title: 'Understand company control',
    route: 'ownership',
    example: 'A 2-of-3 board requires two independent signers. CONTROL shares and a board-change proposal are distinct from signatures approving ordinary company operations. Never replace a real company board while experimenting.',
    exercise: 'Inspect the board threshold and CONTROL holdings. In the governance panel read an eligible target’s status, inspect the proposed signer and activation delay. Propose only for your disposable company; after eligibility and the delay, activate and verify the confirmed board.',
  },
  {
    id: 'dispute',
    prerequisite: 'Switch back to your original disposable personal wallet with funded collateral. A new company may have no accounts.',
    value: 'Ask the blockchain to enforce signed account evidence if cooperation stops.',
    outcome:
      'After the challenge window and finalization, check the reserve receipt. This enforces collateral; it cannot guarantee an unsecured debt.',
    title: 'Exit through a dispute',
    route: 'accounts/configure',
    example:
      'A dispute freezes the account and takes signed evidence to its jurisdiction. A challenge window lets newer evidence answer. Finalization releases the winning collateral to reserve; unsecured promises are not guaranteed collateral.',
    exercise:
      'Last exercise, on a disposable test account: fund gas and collateral, open Dispute, review the timeout, submit the batch and wait. Verify finalization and reserve receipt. Keep the wallet online or verify tower coverage.',
  },
] as const;
export type WalletLessonId = (typeof WALLET_LESSONS)[number]['id'];
