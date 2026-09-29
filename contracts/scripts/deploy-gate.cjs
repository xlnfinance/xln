// Deploy gate: this build's response-window floor (Account.MIN_RESPONSE_SECONDS) is a TESTNET number. A deploy to any
// chain that is not a named testnet is refused while the floor is below MAINNET_MIN_RESPONSE_SECONDS, because a
// counterparty who is offline overnight must still be able to answer a dispute (contracts-decisions.md, H2).
//
// Every deploy entry point must call `assertResponseFloor` before it sends anything (deploy-chain-matrix.cjs for the
// matrix, deploy-stack.cjs, which Hardhat launches); test/gate/deploy-gate.test.ts fails if a deploy script does not.
//
// The floor is read from the COMPILED build (solc's AST in the Hardhat build-info), never from source text, so a
// comment cannot mask it. Build-info whose recorded sources differ from the files on disk is stale and does not count.
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

/**
 * The floor of the compiled build that matches the sources on disk. Throws if no build-info matches (never compiled, or
 * stale: the artifacts are older than the source), so a prebuilt artifact cannot smuggle in another value.
 */
const readCompiledFloor = (root = contractsRoot) => {
  const dir = path.join(root, 'artifacts', 'build-info');
  const outputs = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.output.json')) : [];
  for (const output of outputs) {
    const inputFile = path.join(dir, output.replace(/\.output\.json$/, '.json'));
    if (!existsSync(inputFile)) continue;
    const input = JSON.parse(readFileSync(inputFile, 'utf8')).input;
    if (!sourcesMatchDisk(input, root)) continue;
    const sources = JSON.parse(readFileSync(path.join(dir, output), 'utf8')).output.sources;
    const account = sources['project/contracts/Account.sol'];
    if (account) return floorFromAst(account.ast);
  }
  throw new Error('no compiled build matches the sources on disk (not compiled, or artifacts older than the source): run hardhat compile');
};

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

module.exports = {
  MAINNET_MIN_RESPONSE_SECONDS, NAMED_TESTNET_CHAIN_IDS, isNamedTestnet, floorFromAst, readCompiledFloor, assertResponseFloor,
};
