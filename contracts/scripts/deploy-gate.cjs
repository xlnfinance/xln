// Deploy gate: this build's response-window floor (Account.MIN_RESPONSE_SECONDS) is a TESTNET number. A deploy to any
// chain that is not a named testnet is refused while the floor is below MAINNET_MIN_RESPONSE_SECONDS, because a
// counterparty who is offline overnight must still be able to answer a dispute (contracts-decisions.md, H2).
const { readFileSync } = require('node:fs');
const path = require('node:path');

/** Hours, not seconds. Raise it before the first mainnet deploy if the launch policy wants a longer floor. */
const MAINNET_MIN_RESPONSE_SECONDS = 6 * 60 * 60;
/** Chain ids from deploy-chain-matrix.cjs profiles that may carry the testnet floor. Everything else is mainnet. */
const NAMED_TESTNETS = new Set(['ethereum-sepolia', 'tron-nile']);

const UNIT_SECONDS = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

/** Read `MIN_RESPONSE_SECONDS = <n> [unit]` from Account.sol source. Anything unparsable returns null (the gate fails closed). */
const parseMinResponseSeconds = (source) => {
  const match = /\bMIN_RESPONSE_SECONDS\s*=\s*(\d+)\s*(seconds|minutes|hours|days)?\s*;/.exec(source);
  if (!match) return null;
  return Number(match[1]) * UNIT_SECONDS[match[2] || 'seconds'];
};

const accountSource = () => readFileSync(path.join(__dirname, '..', 'contracts', 'Account.sol'), 'utf8');

/** Throw if any selected chain is not a named testnet while the compiled floor is below the mainnet minimum. */
const assertResponseFloor = (chains, source = accountSource()) => {
  const floor = parseMinResponseSeconds(source);
  const gated = chains.filter((chain) => !NAMED_TESTNETS.has(chain.id));
  if (gated.length === 0) return floor;
  if (floor === null) {
    throw new Error(`Deploy gate: cannot read MIN_RESPONSE_SECONDS from Account.sol, refusing ${gated.map((c) => c.id).join(', ')}`);
  }
  if (floor < MAINNET_MIN_RESPONSE_SECONDS) {
    throw new Error(
      `Deploy gate: MIN_RESPONSE_SECONDS is ${floor}s, below the mainnet floor of ${MAINNET_MIN_RESPONSE_SECONDS}s. ` +
      `Refusing ${gated.map((c) => c.id).join(', ')}; only ${[...NAMED_TESTNETS].join(', ')} may carry the testnet value.`,
    );
  }
  return floor;
};

module.exports = { MAINNET_MIN_RESPONSE_SECONDS, NAMED_TESTNETS, parseMinResponseSeconds, assertResponseFloor };
