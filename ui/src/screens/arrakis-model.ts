type Balance = { tokenId: number; reserve: string; secured: string; receivable: string; debt: string; net: string };
type Entity = {
  role: string;
  name: string;
  id: string;
  height: number;
  threshold: string;
  validators: string[];
  balances: Balance[];
};
export type World = {
  completed: string[];
  next: string | null;
  busy: string | null;
  error: string | null;
  height: number;
  runtimeId: string;
  tokens: { id: number; symbol: string; decimals: number }[];
  entities: Entity[];
};
export const actions = [
  {
    id: 'launch',
    label: 'Enter Arrakis',
    title: 'Build an economy. Then take the wheel.',
    text: 'Four Entities. One exchange. A real test asset called Spice. Every trade runs through XLN’s signed bilateral Accounts.',
    button: 'Launch your economy',
    detail: 'Creates a private EVM, registers Entities and opens the market.',
  },
  {
    id: 'pay',
    label: 'Move Spice',
    title: 'Money moves at the speed of agreement.',
    text: 'Caravan pays the exchange 5 Spice through its signed Account. No blockchain transaction for this payment.',
    button: 'Pay 5 Spice',
    detail: 'Caravan → Arrakis Exchange · operating payment',
  },
  {
    id: 'buy',
    label: 'Buy the company',
    title: 'Own a majority. Start with a trade.',
    text: 'Exchange 6 million Spice for 60 billion CONTROL shares in Sirocco. The exchange matches two bilateral orders.',
    button: 'Buy 60% for 6M Spice',
    detail: 'Signed claims are tradable; voting power requires settlement into your reserve.',
  },
  {
    id: 'settle',
    label: 'Settle your shares',
    title: 'Turn your claim into voting power.',
    text: 'Settle the purchased shares from the seller through the exchange into your Entity’s reserve. The contract now sees your 60% holding.',
    button: 'Settle 60B CONTROL',
    detail: 'Three cooperative settlements. Only collateral secures recovery.',
  },
  {
    id: 'propose',
    label: 'Nominate your board',
    title: 'A majority gets a voice.',
    text: 'You are already a minority director. With a settled majority, nominate yourself as Sirocco’s sole director.',
    button: 'Propose your board',
    detail: 'The contract verifies ownership and starts its governance delay.',
  },
  {
    id: 'activate',
    label: 'Take control',
    title: 'Ownership becomes authority.',
    text: 'Advance this private world past the one-day governance delay, then activate the new board. Other wallets and networks keep their own clocks.',
    button: 'Advance one day & activate',
    detail: 'Local simulated time · the deployed contract still enforces its delay.',
  },
  {
    id: 'treasury',
    label: 'Use your authority',
    title: 'Your signature. The company’s treasury.',
    text: 'Authorize a transfer of one CONTROL share from Sirocco’s reserve to your signing address. The former 2-of-3 board is no longer required.',
    button: 'Transfer 1 treasury share',
    detail: 'Checks the reserve debit, custody debit and recipient credit against the EVM.',
  },
  {
    id: 'sell',
    label: 'Trade again',
    title: 'Let capital keep moving.',
    text: 'Sell 10 billion CONTROL back to Sirocco for 1 million Spice, less the exchange’s signed fee. Your settled reserve stays put; the Account records your delivery obligation.',
    button: 'Sell 10B CONTROL',
    detail: 'This is credit-backed trading. View reserve holdings and Account debt separately below.',
  },
] as const;
