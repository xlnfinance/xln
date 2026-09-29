// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "../helpers/XlnFixture.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import "../../../contracts/Types.sol";

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
    (n, , , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(entity[0], entity[1]));
  }

  function _proofBody(Int512 memory offdelta) internal pure returns (ProofBody memory pb) {
    pb.watchSeed = keccak256("chunk");
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.offdeltas = new Int512[](1);
    pb.offdeltas[0] = offdelta;
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = T;
    pb.transformers = new TransformerClause[](0);
  }

  /// @dev One dispute cycle that leaves LEFT owing RIGHT `DEBT_SIZE`.
  ///      LEFT holds no spendable reserve, so the shortfall becomes a new debt.
  function _mintOneDebt() internal {
    _mintDebt(WideMath.fromInt(-int256(DEBT_SIZE)));
  }

  /// @dev Both real Entity Hankos commit this exact wide proof and fresh nonce.
  ///      No reserve or collateral is injected to manufacture the debt amount.
  function _mintDebt(Int512 memory offdelta) internal {
    ProofBody memory pb = _proofBody(offdelta);
    bytes32 pbHash = keccak256(abi.encode(pb));
    uint256 nonce = _accountNonce() + 1;
    bool startedByLeft = entity[0] < entity[1];
    bool proposerIsLeft = entity[1] < entity[0];

    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[1],
      nonce: nonce,
      proposerIsLeft: proposerIsLeft,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: pb.watchSeed,
      sig: _hanko(1, XlnHanko.disputeProofHash(
        address(dep), XlnHanko.accountKey(entity[0], entity[1]), nonce, proposerIsLeft, pbHash, pb.watchSeed
      )),
      starterInitialArguments: "",
      starterCounterArguments: "",
      starterCounterProofCommitment: bytes32(0)
    });
    assertTrue(_submit(0, start), "dispute start failed");
    (, , uint256 disputeTimeout, , , , , , , , , , , , ) =
      dep._accounts(XlnHanko.accountKey(entity[0], entity[1]));
    // disputeTimeout is absolute unix end; warp past it (seconds clock).
    vm.warp(disputeTimeout + 1);

    Batch memory fin = XlnHanko.emptyBatch();
    fin.disputeFinalizations = new FinalDisputeProof[](1);
    fin.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: entity[1],
      initialNonce: nonce,
      finalNonce: nonce,
      proposerIsLeft: proposerIsLeft,
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

  function _assertOutstanding(Uint768 memory expected, string memory reason) internal view {
    (uint256 high, uint256 middle, uint256 low) = dep.debtOutstanding(debtor, T);
    assertEq(high, expected.high, string.concat(reason, ": high"));
    assertEq(middle, expected.middle, string.concat(reason, ": middle"));
    assertEq(low, expected.low, string.concat(reason, ": low"));
  }

  function _assertBoundedOutstanding(uint256 expected, string memory reason) internal view {
    _assertOutstanding(Uint768(0, 0, expected), reason);
  }

  function _queueLength(bytes32 e) internal view returns (uint256 len) {
    for (uint256 i = 0; i < 256; i++) {
      try dep._debts(e, T, i) returns (bytes32, Uint512 memory) { len = i + 1; } catch { break; }
    }
  }

  function _liveDebt(bytes32 e) internal view returns (Uint768 memory sum, uint256 count) {
    uint256 len = _queueLength(e);
    for (uint256 i = 0; i < len; i++) {
      (, Uint512 memory amount) = dep._debts(e, T, i);
      if (!WideMath.isZero(amount)) { sum = WideMath.add(sum, WideMath.expand(amount)); count++; }
    }
  }

  function _assertBooksAgree(string memory tag) internal view {
    (Uint768 memory sum, uint256 count) = _liveDebt(debtor);
    _assertOutstanding(sum, string.concat(tag, ": debtOutstanding desynced"));
    assertEq(count, dep.activeDebts(debtor), string.concat(tag, ": activeDebts desynced"));

    uint256 cursor = dep._debtIndex(debtor, T);
    uint256 len = _queueLength(debtor);
    for (uint256 i = 0; i < cursor && i < len; i++) {
      (, Uint512 memory amount) = dep._debts(debtor, T, i);
      assertTrue(WideMath.isZero(amount), string.concat(tag, ": cursor skipped an unpaid debt"));
    }
  }

  function _buildDebts(uint256 n) internal {
    for (uint256 i = 0; i < n; i++) _mintOneDebt();
    _assertBoundedOutstanding(n * DEBT_SIZE, "setup: wrong total debt");
    assertEq(dep.activeDebts(debtor), n, "setup: wrong active count");
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
    _assertBoundedOutstanding((n - DEBT_CHUNK) * DEBT_SIZE, "chunk 1 paid the wrong amount");
    assertEq(dep.activeDebts(debtor), n - DEBT_CHUNK, "chunk 1 count wrong");
    assertEq(dep._debtIndex(debtor, T), DEBT_CHUNK, "cursor did not advance one full chunk");

    // Second chunk drains the rest and resets the queue.
    dep.enforceDebts(debtor, T, DEBT_CHUNK);
    _assertBooksAgree("after chunk 2");
    _assertBoundedOutstanding(0, "debt survived full enforcement");
    assertEq(dep.activeDebts(debtor), 0, "active count survived full enforcement");
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

    _assertBoundedOutstanding(5 * DEBT_SIZE - (2 * DEBT_SIZE + DEBT_SIZE / 2), "partial outstanding");
    assertEq(dep.activeDebts(debtor), 3, "partially paid entry must stay active");
    assertEq(dep._debtIndex(debtor, T), 2, "cursor must rest on the partially paid entry");
    (, Uint512 memory remainder) = dep._debts(debtor, T, 2);
    assertEq(remainder.high, 0, "partial remainder high");
    assertEq(remainder.low, DEBT_SIZE / 2, "partial remainder wrong");
  }

  /// @notice `maxIterations == 0` drains without a slot cap.
  function test_uncappedEnforcementDrainsEverything() public {
    _buildDebts(40);
    dep.mintToReserve(debtor, T, 40 * DEBT_SIZE);

    dep.enforceDebts(debtor, T, 0);
    _assertBooksAgree("after uncapped drain");
    _assertBoundedOutstanding(0, "no outstanding");
    assertEq(dep.activeDebts(debtor), 0);
    assertEq(_queueLength(debtor), 0);
  }

  /// @notice Forgiveness applied on top of a half-drained queue must not
  ///         double-decrement the active count or strand the cursor.
  function test_forgivenessAfterPartialEnforcementKeepsBooksExact() public {
    _buildDebts(35);
    dep.mintToReserve(debtor, T, DEBT_CHUNK * DEBT_SIZE);
    dep.enforceDebts(debtor, T, DEBT_CHUNK);
    _assertBooksAgree("after chunk");
    assertEq(dep.activeDebts(debtor), 3);

    // A signed settlement forgives only the current FIFO head.
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
    _assertBoundedOutstanding(2 * DEBT_SIZE, "forgiveness must preserve the tail");
    assertEq(dep.activeDebts(debtor), 2, "forgiveness must clear only one active entry");
    assertEq(dep._debtIndex(debtor, T), DEBT_CHUNK + 1, "forgiveness must advance one slot");

    // Funding the remaining tail must drain exactly once without an underflow.
    uint256 creditorBefore = dep._reserves(creditor, T);
    dep.mintToReserve(debtor, T, 2 * DEBT_SIZE);
    dep.enforceDebts(debtor, T, DEBT_CHUNK);
    _assertBooksAgree("after post-forgiveness enforcement");
    _assertBoundedOutstanding(0, "tail not drained");
    assertEq(dep._reserves(creditor, T) - creditorBefore, 2 * DEBT_SIZE, "tail payment wrong");
  }
  /// @notice A signed debt of 2^256 remains payable; paying one borrows from
  ///         its high word and leaves exactly UINT256_MAX, not zero or a wrap.
  function test_signedDebtCrossesUint256WordOnPartialRepayment() public {
    _mintDebt(Int512(-1, 0));
    _assertOutstanding(Uint768(0, 1, 0), "wide debt created");
    (bytes32 owner, Uint512 memory amount) = dep._debts(debtor, T, 0);
    assertEq(owner, creditor, "wrong signed creditor");
    assertEq(amount.high, 1, "debt high");
    assertEq(amount.low, 0, "debt low");

    dep.mintToReserve(debtor, T, 1);
    dep.enforceDebts(debtor, T, 1);
    _assertBooksAgree("after debt-word borrow");
    _assertBoundedOutstanding(type(uint256).max, "exact remaining debt");
    (, amount) = dep._debts(debtor, T, 0);
    assertEq(amount.high, 0, "borrow did not clear high word");
    assertEq(amount.low, type(uint256).max, "borrow remainder");
    assertEq(dep.activeDebts(debtor), 1, "partial debt must remain active");
    assertEq(dep._debtIndex(debtor, T), 0, "partial debt cursor");
    assertEq(dep._reserves(debtor, T), 0, "debtor payment");
    assertEq(dep._reserves(creditor, T), 1, "creditor payment");
  }

  /// @notice Two real signed minimum-offset disputes book 2^511 each. Their
  ///         aggregate must carry into the third word; paying one borrows back.
  function test_signedDebtsCrossUint512OutstandingWord() public {
    _mintDebt(Int512(type(int256).min, 0));
    _mintDebt(Int512(type(int256).min, 0));
    _assertBooksAgree("after outstanding carry");
    _assertOutstanding(Uint768(1, 0, 0), "2^512 outstanding");
    assertEq(dep.activeDebts(debtor), 2, "two signed debts");

    dep.mintToReserve(debtor, T, 1);
    dep.enforceDebts(debtor, T, 1);
    _assertBooksAgree("after outstanding borrow");
    _assertOutstanding(Uint768(0, type(uint256).max, type(uint256).max), "2^512 minus one");
    (, Uint512 memory head) = dep._debts(debtor, T, 0);
    (, Uint512 memory tail) = dep._debts(debtor, T, 1);
    assertEq(head.high, uint256(type(int256).max), "head borrowed high");
    assertEq(head.low, type(uint256).max, "head borrowed low");
    assertEq(tail.high, uint256(1) << 255, "tail high unchanged");
    assertEq(tail.low, 0, "tail low unchanged");
    assertEq(dep.activeDebts(debtor), 2, "partial head and tail stay active");
    assertEq(dep._debtIndex(debtor, T), 0, "partial head keeps cursor");
    assertEq(dep._reserves(debtor, T), 0, "debtor payment");
    assertEq(dep._reserves(creditor, T), 1, "creditor payment");
  }

}
