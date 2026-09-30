// Deploy gate: this build's response-window floor (Account.MIN_RESPONSE_SECONDS) is a TESTNET number. A deploy to any
// chain that is not a named testnet is refused while the floor is below MAINNET_MIN_RESPONSE_SECONDS, because a
// counterparty who is offline overnight must still be able to answer a dispute (contracts-decisions.md, H2).
//
// Every deploy entry point must call `assertDeployGate` (which runs `assertResponseFloor`) before it sends anything (deploy-chain-matrix.cjs for the
// matrix, deploy-stack.cjs, which Hardhat launches); test/gate/deploy-gate.test.ts fails if a deploy script does not.
//
// The floor is read from the COMPILED build (solc's AST in the Hardhat build-info), never from source text, so a
// comment cannot mask it. Build-info whose recorded sources differ from the files on disk is stale and does not count.
//
// Second gate (J5, PR #54): every batch carries a signed gas budget (at least DepositoryBounds.MIN_BATCH_GAS_BUDGET), and processBatch needs the
// transaction to carry budget * 64/63 + Depository.BATCH_POST_CALL_RESERVE on top of the outer hanko check of the entity's own board. The chain's
// per-transaction gas cap (EIP-7825 on Ethereum: 2^24) must cover that for the largest supported board, or an entity of that size can never have a
// failing batch reported (contracts-decisions.md, J5). `assertBatchGasCap` checks it, `assertDeployGate` runs both gates.
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const contractsRoot = path.resolve(__dirname, '..');

/** Hours, not seconds. Raise it before the first mainnet deploy if the launch policy wants a longer floor. */
const MAINNET_MIN_RESPONSE_SECONDS = 6 * 60 * 60;
/** Chains that may carry the testnet floor, by chain id (never by network or profile name): local dev nets, Ethereum Sepolia, Base Sepolia, TRON Nile. */
const NAMED_TESTNET_CHAIN_IDS = new Set([31337, 11155111, 84532, 3448148188]);

const isNamedTestnet = (chain) => NAMED_TESTNET_CHAIN_IDS.has(Number(chain.chainId));

const UNIT_SECONDS = { seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800 };

/** Evaluate a constant expression from solc's AST: number literals with units and + - * /. Anything else is null. */
const evalNode = (node) => {
  if (!node) return null;
  if (node.nodeType === 'Literal' && node.kind === 'number') {
    const value = Number(String(node.value).replace(/_/g, ''));
    const unit = node.subdenomination ? UNIT_SECONDS[node.subdenomination] : 1;
    return Number.isFinite(value) && unit !== undefined ? value * unit : null;
  }
  if (node.nodeType === 'BinaryOperation') {
    const left = evalNode(node.leftExpression), right = evalNode(node.rightExpression);
    if (left === null || right === null) return null;
    if (node.operator === '+') return left + right;
    if (node.operator === '-') return left - right;
    if (node.operator === '*') return left * right;
    if (node.operator === '/') return right === 0 ? null : Math.floor(left / right);
  }
  return null;
};

const findConstant = (node, name) => {
  if (!node || typeof node !== 'object') return undefined;
  if (node.nodeType === 'VariableDeclaration' && node.name === name && node.constant) return node;
  for (const value of Object.values(node)) {
    const found = Array.isArray(value)
      ? value.map((child) => findConstant(child, name)).find((hit) => hit !== undefined)
      : findConstant(value, name);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** MIN_RESPONSE_SECONDS from Account's AST, or null if the expression is not a plain constant. */
const floorFromAst = (ast) => evalNode(findConstant(ast, 'MIN_RESPONSE_SECONDS')?.value);

/** True if every project source recorded in a build-info input is byte-identical to the file on disk. */
const sourcesMatchDisk = (input, root) => Object.entries(input.sources || {})
  .filter(([name]) => name.startsWith('project/contracts/'))
  .every(([name, source]) => {
    const file = path.join(root, name.slice('project/'.length));
    return existsSync(file) && readFileSync(file, 'utf8') === source.content;
  });

/** A named constant of a contract's AST, evaluated (number literals with units and + - * /), or null when it is not a plain constant. */
const constantFromAst = (ast, name) => evalNode(findConstant(ast, name)?.value);

/**
 * The compiled sources of the build that matches the sources on disk, for the first build that has every file in `files`. Throws if no
 * build-info matches (never compiled, or stale: the artifacts are older than the source), so a prebuilt artifact cannot smuggle in another value.
 */
const compiledSources = (files, root = contractsRoot) => {
  const dir = path.join(root, 'artifacts', 'build-info');
  const outputs = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.output.json')) : [];
  for (const output of outputs) {
    const inputFile = path.join(dir, output.replace(/\.output\.json$/, '.json'));
    if (!existsSync(inputFile)) continue;
    const input = JSON.parse(readFileSync(inputFile, 'utf8')).input;
    if (!sourcesMatchDisk(input, root)) continue;
    const sources = JSON.parse(readFileSync(path.join(dir, output), 'utf8')).output.sources;
    if (files.every((file) => sources[file])) return sources;
  }
  throw new Error('no compiled build matches the sources on disk (not compiled, or artifacts older than the source): run hardhat compile');
};

/** The floor of the compiled build that matches the sources on disk. */
const readCompiledFloor = (root = contractsRoot) =>
  floorFromAst(compiledSources(['project/contracts/Account.sol'], root)['project/contracts/Account.sol'].ast);

/**
 * Throw if any chain is not a named testnet while the compiled floor is below the mainnet minimum. `chains` are
 * `{ id?, chainId }`. Fails closed when the floor cannot be read.
 */
const assertResponseFloor = (chains, readFloor = readCompiledFloor) => {
  const gated = chains.filter((chain) => !isNamedTestnet(chain));
  if (gated.length === 0) return null;
  const names = gated.map((chain) => `${chain.id ?? 'chain'} (${chain.chainId})`).join(', ');
  let floor;
  try {
    floor = readFloor();
  } catch (error) {
    throw new Error(`Deploy gate: cannot establish MIN_RESPONSE_SECONDS, refusing ${names}: ${error.message}`);
  }
  if (floor === null || floor === undefined) {
    throw new Error(`Deploy gate: MIN_RESPONSE_SECONDS is not a plain constant in the compiled build, refusing ${names}`);
  }
  if (floor < MAINNET_MIN_RESPONSE_SECONDS) {
    throw new Error(
      `Deploy gate: MIN_RESPONSE_SECONDS is ${floor}s, below the mainnet floor of ${MAINNET_MIN_RESPONSE_SECONDS}s. ` +
      `Refusing ${names}; only chain ids ${[...NAMED_TESTNET_CHAIN_IDS].join(', ')} may carry the testnet value.`,
    );
  }
  return floor;
};

// ---- second gate: the chain's transaction gas cap against the signed gas budget (J5) ----

/** EIP-7825 (Fusaka): the most gas one transaction may carry on Ethereum. */
const EIP_7825_TX_GAS_CAP = 16_777_216;
/**
 * Per-transaction gas cap, by chain id, where the chain fixes one. A chain that is not listed is UNKNOWN, not unlimited: a mainnet with an unknown cap is
 * refused (add its cap here, measured or taken from the chain's own documentation, before deploying); a named testnet with an unknown cap is let through.
 */
const TX_GAS_CAP_BY_CHAIN_ID = new Map([[1, EIP_7825_TX_GAS_CAP], [11155111, EIP_7825_TX_GAS_CAP]]);
const txGasCapOf = (chain) => TX_GAS_CAP_BY_CHAIN_ID.get(Number(chain.chainId)) ?? null;

/** The largest board (EOA validators, all signing) whose outer hanko check the gate budgets for. The check is superlinear in the board size; larger boards are unsupported. */
const SUPPORTED_BOARD_SIGNERS = 128;
/**
 * Gas before the self-call for a board of SUPPORTED_BOARD_SIGNERS: the outer hanko check PLUS the transaction's intrinsic gas (21,000 + calldata), measured at
 * 4,832,492 for 128 signers (test/vm/j5-gas-prelude.test.ts, which adds the intrinsic gas itself because the rig's read-only call charges none, and fails if the
 * measurement passes this constant), rounded up. 64 signers measure 1,528,237; a lone validator 114,639. The first version of this constant left the intrinsic gas
 * out (4,522,148 of execution alone, review of #54 at 0aeb766).
 */
const HANKO_PRELUDE_GAS = 4_900_000;

/** MIN_BATCH_GAS_BUDGET (DepositoryBounds) and BATCH_POST_CALL_RESERVE (Depository) of the compiled build that matches the sources on disk. */
const readCompiledBatchGas = (root = contractsRoot) => {
  const bounds = 'project/contracts/DepositoryBounds.sol', depository = 'project/contracts/Depository.sol';
  const sources = compiledSources([bounds, depository], root);
  return { minBudget: constantFromAst(sources[bounds].ast, 'MIN_BATCH_GAS_BUDGET'), reserve: constantFromAst(sources[depository].ast, 'BATCH_POST_CALL_RESERVE') };
};

/** What one transaction must be able to carry: the supported board's hanko check, the smallest budget with the 63/64 rule, and the post-call reserve. */
const requiredTxGas = ({ minBudget, reserve }) => HANKO_PRELUDE_GAS + Math.ceil((minBudget * 64) / 63) + reserve;

/**
 * Throw if a chain's transaction gas cap cannot carry `requiredTxGas` (a known cap that is too low), or if a chain that is not a named testnet has no known
 * cap. Fails closed when the constants cannot be read from the compiled build (a testnet with an unknown cap is never blocked). `chains` are `{ id?, chainId }`.
 */
const assertBatchGasCap = (chains, readGas = readCompiledBatchGas, capOf = txGasCapOf) => {
  const label = (chain) => `${chain.id ?? 'chain'} (${chain.chainId})`;
  const capped = chains.filter((chain) => capOf(chain) !== null || !isNamedTestnet(chain));
  if (capped.length === 0) return null;
  let gas;
  try {
    gas = readGas();
  } catch (error) {
    throw new Error(`Deploy gate: cannot establish the batch gas budget, refusing ${capped.map(label).join(', ')}: ${error.message}`);
  }
  if (!Number.isFinite(gas?.minBudget) || !Number.isFinite(gas?.reserve)) {
    throw new Error(`Deploy gate: MIN_BATCH_GAS_BUDGET or BATCH_POST_CALL_RESERVE is not a plain constant in the compiled build, refusing ${capped.map(label).join(', ')}`);
  }
  const required = requiredTxGas(gas);
  for (const chain of capped) {
    const cap = capOf(chain);
    if (cap === null) {
      throw new Error(`Deploy gate: the transaction gas cap of ${label(chain)} is not known (TX_GAS_CAP_BY_CHAIN_ID in deploy-gate.cjs), refusing it: a batch needs ${required} gas per transaction.`);
    }
    if (cap < required) {
      throw new Error(
        `Deploy gate: the transaction gas cap of ${label(chain)} is ${cap}, below the ${required} a batch needs: the outer hanko of a supported board ` +
        `(${SUPPORTED_BOARD_SIGNERS} signers, ${HANKO_PRELUDE_GAS} gas) + the smallest signed gas budget ${gas.minBudget} * 64/63 + the post-call reserve ${gas.reserve}.`,
      );
    }
  }
  return required;
};

/** Both gates, before anything is sent: the response-window floor, then the batch gas budget against the transaction gas cap. */
const assertDeployGate = (chains) => {
  assertResponseFloor(chains);
  assertBatchGasCap(chains);
};

module.exports = {
  MAINNET_MIN_RESPONSE_SECONDS, NAMED_TESTNET_CHAIN_IDS, isNamedTestnet, floorFromAst, readCompiledFloor, assertResponseFloor,
  constantFromAst, readCompiledBatchGas, requiredTxGas, txGasCapOf, TX_GAS_CAP_BY_CHAIN_ID, EIP_7825_TX_GAS_CAP, SUPPORTED_BOARD_SIGNERS, HANKO_PRELUDE_GAS,
  assertBatchGasCap, assertDeployGate,
};
