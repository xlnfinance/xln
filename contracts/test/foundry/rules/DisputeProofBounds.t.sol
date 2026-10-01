// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "../helpers/XlnFixture.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import "../../../contracts/Types.sol";

/// @notice Open holds are capped at 32, and the chain's side of that cap is the proof body: a dispute proof carrying more than 32
///         transformer clauses reverts with E10, in a start, a counter and a finalization alike, and the clauses of every token of
///         the body count together. A batch is checked for this before its signature, so the revert tests need no valid signature;
///         "32 is accepted" is shown by the batch getting past the cap to the next check (E4, the bad signature) or, for a start,
///         by landing. Each test names the assertion that carries it.
contract DisputeProofBoundsTest is XlnFixture {
  uint256 internal constant T = 1;
  uint256 internal constant CAP = 32;
  bytes4 internal constant E10_ = bytes4(keccak256("E10()"));
  bytes4 internal constant E4_ = bytes4(keccak256("E4()"));

  function setUp() public {
    _deployXln();
  }

  function _body(uint256 tokens, uint256 clauses) internal view returns (ProofBody memory pb) {
    pb.watchSeed = keccak256("hold cap");
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.offdeltas = new Int512[](tokens);
    pb.tokenIds = new uint256[](tokens);
    for (uint256 i = 0; i < tokens; i++) pb.tokenIds[i] = T + i;
    pb.transformers = new TransformerClause[](clauses);
    for (uint256 i = 0; i < clauses; i++) {
      pb.transformers[i] = TransformerClause({
        transformerAddress: address(deltaTransformer),
        encodedBatch: "",
        allowances: new Allowance[](0)
      });
    }
  }

  function _acct() internal view returns (bytes memory) {
    return XlnHanko.accountKey(entity[0], entity[1]);
  }

  function _startBatch(ProofBody memory pb, uint256 nonce) internal view returns (Batch memory b) {
    bytes32 pbHash = keccak256(abi.encode(pb));
    bool proposerIsLeft = entity[1] < entity[0];
    b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[1],
      nonce: nonce,
      ondeltaEpoch: XlnHanko.currentEpoch(address(dep), _acct()),
      proposerIsLeft: proposerIsLeft,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: pb.watchSeed,
      sig: _hanko(1, XlnHanko.disputeProofHash(address(dep), _acct(), nonce, proposerIsLeft, pbHash, pb.watchSeed)),
      starterInitialArguments: "",
      starterCounterArguments: "",
      starterCounterProofCommitment: bytes32(0)
    });
  }

  function _counterBatch(ProofBody memory pb, uint256 nonce) internal view returns (Batch memory b) {
    b = XlnHanko.emptyBatch();
    b.counterDisputes = new CounterDisputeProof[](1);
    b.counterDisputes[0] = CounterDisputeProof({
      counterentity: entity[1],
      initialNonce: nonce,
      initialProofbodyHash: keccak256("initial"),
      counterNonce: nonce + 1,
      proposerIsLeft: entity[1] < entity[0],
      counterProofbody: pb,
      sig: ""
    });
  }

  function _finalizeBatch(ProofBody memory pb, uint256 nonce) internal view returns (Batch memory b) {
    b = XlnHanko.emptyBatch();
    b.disputeFinalizations = new FinalDisputeProof[](1);
    b.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: entity[1],
      initialNonce: nonce,
      finalNonce: nonce,
      proposerIsLeft: entity[1] < entity[0],
      initialProofbodyHash: keccak256("initial"),
      finalProofbody: pb,
      starterArguments: "",
      otherArguments: "",
      sig: "",
      startedByLeft: entity[0] < entity[1],
      cooperative: false
    });
  }

  /// @dev The batch signed by actor 0 at its next nonce, as a relayer would send it, and the revert it must meet (none when
  ///      `expected` is zero). `signed` false signs the wrong hash, which is the E4 the cap check must come before.
  function _send(Batch memory batch, bool signed, bytes4 expected) internal {
    bytes memory encoded = abi.encode(batch);
    uint256 nonce = dep.entityNonces(entity[0]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[0], encoded, nonce);
    bytes memory hanko = _hanko(0, signed ? h : keccak256("not the batch"));
    if (expected != bytes4(0)) vm.expectRevert(expected);
    dep.processBatch(entity[0], encoded, hanko, nonce);
  }

  /// @dev Sent with a bad signature on purpose: E10, not E4, shows the cap is judged before the signature, by the up-front check.
  function _revertsAtTheCap(Batch memory over) internal {
    _send(over, false, E10_);
  }

  function _passesTheCap(Batch memory exact) internal {
    _send(exact, false, E4_);
  }

  /// @dev A start with 33 clauses reverts E10 (the cap), and one with 32 lands: the Account holds an active dispute afterwards.
  ///      Carried by the E10 expectation (a cap of 33 or a check dropped lets the batch go on) and by the dispute hash being
  ///      set after the 32-clause start (a cap of 31 or `>=` refuses it).
  function test_R_HOLD_CAP_aStartWithThirtyThreeTransformersRevertsAndWithThirtyTwoLands() public {
    _revertsAtTheCap(_startBatch(_body(1, CAP + 1), 1));

    _send(_startBatch(_body(1, CAP), 1), true, bytes4(0));

    (, bytes32 disputeHash,,,,,,,,,,,,,,,) = dep._accounts(_acct());
    assertTrue(disputeHash != bytes32(0), "a start with exactly 32 transformers opens the dispute");
  }

  /// @dev The same bound on a counter. Carried by E10 at 33 and by E4 (the signature check, which comes after the cap) at 32.
  function test_R_HOLD_CAP_aCounterWithThirtyThreeTransformersReverts() public {
    _revertsAtTheCap(_counterBatch(_body(1, CAP + 1), 1));
    _passesTheCap(_counterBatch(_body(1, CAP), 1));
  }

  /// @dev The same bound on a finalization.
  function test_R_HOLD_CAP_aFinalizationWithThirtyThreeTransformersReverts() public {
    _revertsAtTheCap(_finalizeBatch(_body(1, CAP + 1), 1));
    _passesTheCap(_finalizeBatch(_body(1, CAP), 1));
  }

  /// @dev A body carries the transformers of every token, so the cap is on the body, not on a token: two tokens with 17 and 16
  ///      clauses are 33 together and revert. Carried by E10 on a two-token body whose clauses per token are each under 32.
  function test_R_HOLD_CAP_theClausesOfAllTheTokensOfABodyCountTogether() public {
    _revertsAtTheCap(_startBatch(_body(2, CAP + 1), 1));
    _passesTheCap(_counterBatch(_body(2, CAP), 1));
  }
}
