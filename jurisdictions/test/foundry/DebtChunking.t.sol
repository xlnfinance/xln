// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import "../../contracts/Types.sol";

/// @notice Task item 3, chunking half. A stateful fuzzer will not stack 33+
///         debts on one (entity, token) by chance, so the FIFO cursor across
///         DEBT_ENFORCEMENT_CHUNK = 32 boundaries is driven deterministically.
contract DebtChunkingTest is XlnFixture {
  uint256 internal constant T = 1;
  uint256 internal constant DEBT_CHUNK = 32;
  uint256 internal constant DEBT_SIZE = 100;

  bytes32 internal debtor;
  bytes32 internal creditor;

  function setUp() public {
    _deployXln();
    (debtor, creditor) = entity[0] < entity[1] ? (entity[0], entity[1]) : (entity[1], entity[0]);
  }

  function _accountNonce() internal view returns (uint256 n) {
    (n,,,,,,,) = dep._accounts(XlnHanko.accountKey(entity[0], entity[1]));
  }

  function _proofBody(int256 offdelta) internal pure returns (ProofBody memory pb) {
    pb.watchSeed = keccak256("chunk");
    pb.offdeltas = new int256[](1);
    pb.offdeltas[0] = offdelta;
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = T;
    pb.transformers = new TransformerClause[](0);
  }

  /// @dev One dispute cycle that leaves LEFT owing RIGHT `DEBT_SIZE`.
  ///      LEFT holds no spendable reserve, so the shortfall becomes a new debt.
  function _mintOneDebt() internal {
    int256 offdelta = -int256(DEBT_SIZE);
    ProofBody memory pb = _proofBody(offdelta);
    bytes32 pbHash = keccak256(abi.encode(pb));
    uint256 nonce = _accountNonce() + 1;
    bool startedByLeft = entity[0] < entity[1];

    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[1],
      nonce: nonce,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: pb.watchSeed,
      sig: _hanko(1, XlnHanko.disputeProofHash(
        address(dep), XlnHanko.accountKey(entity[0], entity[1]), nonce, pbHash, pb.watchSeed
      )),
      starterInitialArguments: "",
      starterIncrementedArguments: ""
    });
    assertTrue(_submit(0, start), "dispute start failed");
    (, , uint256 disputeTimeout,,,,,) =
      dep._accounts(XlnHanko.accountKey(entity[0], entity[1]));
    // Read the contract's exact deadline. Optimized Solidity may common-subexpression
    // eliminate repeated block.number reads around the vm.roll cheatcode, which made
    // the second cycle roll back to the first cycle's cached height.
    vm.roll(disputeTimeout);

    Batch memory fin = XlnHanko.emptyBatch();
    fin.disputeFinalizations = new FinalDisputeProof[](1);
    fin.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: entity[1],
      initialNonce: nonce,
      finalNonce: nonce,
      initialProofbodyHash: pbHash,
      finalProofbody: pb,
      starterArguments: "",
      otherArguments: "",
      sig: "",
      startedByLeft: startedByLeft,
      cooperative: false
    });
    assertTrue(_submit(0, fin), "dispute finalize failed");
  }

  function _queueLength(bytes32 e) internal view returns (uint256 len) {
    for (uint256 i = 0; i < 256; i++) {
      try dep._debts(e, T, i) returns (bytes32, uint256) { len = i + 1; } catch { break; }
    }
  }

  function _liveDebt(bytes32 e) internal view returns (uint256 sum, uint256 count) {
    uint256 len = _queueLength(e);
    for (uint256 i = 0; i < len; i++) {
      (, uint256 amount) = dep._debts(e, T, i);
      if (amount != 0) { sum += amount; count++; }
    }
  }

  function _assertBooksAgree(string memory tag) internal view {
    (uint256 sum, uint256 count) = _liveDebt(debtor);
    assertEq(sum, dep.debtOutstanding(debtor, T), string.concat(tag, ": debtOutstanding desynced"));
    assertEq(count, dep._activeDebtsByToken(debtor, T), string.concat(tag, ": activeDebts desynced"));

    uint256 cursor = dep._debtIndex(debtor, T);
    uint256 len = _queueLength(debtor);
    for (uint256 i = 0; i < cursor && i < len; i++) {
      (, uint256 amount) = dep._debts(debtor, T, i);
      assertEq(amount, 0, string.concat(tag, ": cursor skipped an unpaid debt"));
    }
  }

  function _buildDebts(uint256 n) internal {
    for (uint256 i = 0; i < n; i++) _mintOneDebt();
    assertEq(dep.debtOutstanding(debtor, T), n * DEBT_SIZE, "setup: wrong total debt");
    assertEq(dep._activeDebtsByToken(debtor, T), n, "setup: wrong active count");
  }

  /// @notice A queue longer than one chunk must drain across several calls
  ///         without losing, double-counting or stranding a single debt.
  function test_debtSurvivesChunkedEnforcement() public {
    uint256 n = 35; // 32 + 3, straddles exactly one chunk boundary
    _buildDebts(n);
    _assertBooksAgree("after build");

    dep.mintToReserve(debtor, T, n * DEBT_SIZE);
    uint256 creditorBefore = dep._reserves(creditor, T);

    // First chunk: exactly DEBT_CHUNK entries settle.
    dep.enforceDebts(debtor, T, DEBT_CHUNK);
    _assertBooksAgree("after chunk 1");
    assertEq(dep.debtOutstanding(debtor, T), (n - DEBT_CHUNK) * DEBT_SIZE, "chunk 1 paid the wrong amount");
    assertEq(dep._activeDebtsByToken(debtor, T), n - DEBT_CHUNK, "chunk 1 count wrong");
    assertEq(dep._debtIndex(debtor, T), DEBT_CHUNK, "cursor did not advance one full chunk");

    // Second chunk drains the rest and resets the queue.
    dep.enforceDebts(debtor, T, DEBT_CHUNK);
    _assertBooksAgree("after chunk 2");
    assertEq(dep.debtOutstanding(debtor, T), 0, "debt survived full enforcement");
    assertEq(dep._activeDebtsByToken(debtor, T), 0, "active count survived full enforcement");
    assertEq(dep._debtIndex(debtor, T), 0, "cursor not reset after drain");
    assertEq(_queueLength(debtor), 0, "queue not cleared after drain");

    assertEq(
      dep._reserves(creditor, T) - creditorBefore,
      n * DEBT_SIZE,
      "creditor was not made whole"
    );
  }

  /// @notice Partial repayment: reserve covers 2.5 debts, so the third entry
  ///         must be left partially paid and the cursor must stay on it.
  function test_partialRepaymentKeepsBooksExact() public {
    _buildDebts(5);
    dep.mintToReserve(debtor, T, DEBT_SIZE * 2 + DEBT_SIZE / 2);

    dep.enforceDebts(debtor, T, DEBT_CHUNK);
    _assertBooksAgree("after partial");

    assertEq(dep.debtOutstanding(debtor, T), 5 * DEBT_SIZE - (2 * DEBT_SIZE + DEBT_SIZE / 2));
    assertEq(dep._activeDebtsByToken(debtor, T), 3, "partially paid entry must stay active");
    assertEq(dep._debtIndex(debtor, T), 2, "cursor must rest on the partially paid entry");
    (, uint256 remainder) = dep._debts(debtor, T, 2);
    assertEq(remainder, DEBT_SIZE / 2, "partial remainder wrong");
  }

  /// @notice `maxIterations == 0` drains without a slot cap.
  function test_uncappedEnforcementDrainsEverything() public {
    _buildDebts(40);
    dep.mintToReserve(debtor, T, 40 * DEBT_SIZE);

    dep.enforceDebts(debtor, T, 0);
    _assertBooksAgree("after uncapped drain");
    assertEq(dep.debtOutstanding(debtor, T), 0);
    assertEq(dep._activeDebtsByToken(debtor, T), 0);
    assertEq(_queueLength(debtor), 0);
  }

  /// @notice Forgiveness applied on top of a half-drained queue must not
  ///         double-decrement the active count or strand the cursor.
  function test_forgivenessAfterPartialEnforcementKeepsBooksExact() public {
    _buildDebts(35);
    dep.mintToReserve(debtor, T, DEBT_CHUNK * DEBT_SIZE);
    dep.enforceDebts(debtor, T, DEBT_CHUNK);
    _assertBooksAgree("after chunk");
    assertEq(dep._activeDebtsByToken(debtor, T), 3);

    // Forgive the remainder through a signed settlement between the two parties.
    uint256[] memory forgiveIds = new uint256[](1);
    forgiveIds[0] = T;
    SettlementDiff[] memory diffs = new SettlementDiff[](0);
    uint256 nonce = _accountNonce() + 1;
    bytes32 h = XlnHanko.cooperativeUpdateHash(
      address(dep), XlnHanko.accountKey(entity[0], entity[1]), nonce, diffs, forgiveIds
    );

    Batch memory b = XlnHanko.emptyBatch();
    b.settlements = new Settlement[](1);
    b.settlements[0] = Settlement({
      leftEntity: debtor,
      rightEntity: creditor,
      diffs: diffs,
      forgiveDebtsInTokenIds: forgiveIds,
      sig: _hanko(1, h),
      nonce: nonce
    });
    assertTrue(_submit(0, b), "forgiveness settlement failed");

    _assertBooksAgree("after forgiveness");
    assertEq(dep.debtOutstanding(debtor, T), 0, "forgiveness left residual debt");
    assertEq(dep._activeDebtsByToken(debtor, T), 0, "forgiveness left an active count");

    // A later enforcement pass must be a no-op, not an underflow.
    dep.enforceDebts(debtor, T, DEBT_CHUNK);
    _assertBooksAgree("after post-forgiveness enforcement");
  }
}
