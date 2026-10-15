# Arrakis: the local economy demo

Open <http://localhost:5183/arrakis> with the React development server running.
Start the private world with `bun run demo:arrakis`. The service binds only to
127.0.0.1:8086, accepts the local React origins, and never connects to a public
RPC or reads an existing wallet seed. No password or seed phrase is needed.
The route is available only in the development build.

The eight buttons perform the existing company lifecycle, one step at a time:

1. Deploy a distinct six-decimal Spice ERC20, register four Entities, release
   Sirocco CONTROL and DIVIDEND shares, fund Accounts and publish offers.
2. Pay five Spice from Caravan Logistics to Arrakis Exchange.
3. Buy 60 billion CONTROL (60% of supply) for six million Spice.
4. Cooperatively settle CONTROL into the investor Entity reserve.
5. Use the settled majority to propose the investor as sole director.
6. Advance only this private EVM beyond its one-day governance delay and activate
   the successor board, preserving the Entity's Accounts and reserves.
7. Transfer one treasury CONTROL share with the successor's signature. Check
   the reserve debit, ERC1155 custody debit and recipient credit.
8. Sell ten billion CONTROL back through the same swapbook. The reserve remains
   60 billion; the Account now records a ten-billion delivery obligation.

The investor starts on the original 2-of-3 board as a minority director. This
is the implemented synchronized-successor path, not arbitrary outside takeover.
Sirocco is the demo label for the scenario's registered board company; Caravan
is its single-director company. UI values are read from committed Entity/Account
state through `deriveDelta`; unused credit never appears as owned money.

Spice is not a stablecoin or a dollar claim. Its two seven-million reserve grants
are backed by an actual ERC20 transfer to Depository in the private EVM. Bilateral
claims exceeding their Account collateral remain unsecured. CONTROL and DIVIDEND
are separate ERC1155 classes; this demo does not implement dividend distributions.

The service orchestrates `core/scenarios/company-ipo` and the canonical Runtime,
Entity, Account, swapbook and deployed EVM contracts. It has no second balance
ledger. The company scenario's quote currency is selectable; its existing USDT
scenario keeps the same amounts and semantics. Newly registered ERC20 metadata
is read from the token contract, rather than inferred from the default faucet list.

Reloading the browser resumes the same live world. Completed action retries do
not resubmit transactions; commands identify their world to reject stale tabs.
A partially failed step stops the journey instead of guessing whether to repeat
it. The explicit new-world button replaces a completed local world. Server restart
also creates a new world: this demo is memory-only and is not a crash-recovery
claim. It does not reset or advance the existing dev stand or wallet databases.

All actors and signing keys are local and affiliated. This is an interactive
experimental simnet, not Sepolia evidence, a mainnet feature, production custody,
GDP attribution or MML adoption. Private EVM success does not replace the public
chain and recovery release gates.
