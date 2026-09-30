// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "../helpers/XlnFixture.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import "../../../contracts/EntityTypes.sol";
import "../../../contracts/Types.sol";

/// @notice H3: a retired board keeps seven days of dispute evidence, but a dispute that settles on it cannot make the
///         RETIRED side pay from reserves. A retired Left is clamped at delta >= 0, a retired Right at delta <= collateral.
///         The direction in which the retired entity is OWED is never clamped, so a debtor cannot forgive its own debt by
///         racing a rotation. Mirrors test/vm/h3-retired-board-cap.test.ts against the real EntityProvider + Depository.
///
///         X is the numbered entity that rotates from key OLD to key NEW after both sides hold funded reserves and Left
///         has 100 in collateral. Y is its counterparty and never rotates. Numbered ids sort below every lazy hash id, so
///         with a lazy Y (entity[0]) X is Left; registering Y as a numbered entity FIRST makes Y Left and X Right.
abstract contract RetiredBoardH3Base is XlnFixture {
  uint256 internal constant T = 1;
  uint256 internal constant T0 = 1_800_000_000;
  uint256 internal constant OLD_PK = uint256(keccak256("h3.old.board"));
  uint256 internal constant NEW_PK = uint256(keccak256("h3.new.board"));
  uint256 internal constant Y_PK = uint256(keccak256("h3.y.board"));

  bytes32 internal X; // numbered, rotates
  bytes32 internal Y; // never rotates
  uint256 internal yKey;
  bool internal xIsLeft;
  uint256 internal rotatedAt;
  uint256 internal epoch;

  function _setUpWorld(bool xRight) internal {
    _deployXln();
    vm.warp(T0);
    if (xRight) {
      Y = bytes32(ep.registerNumberedEntity(_board(vm.addr(Y_PK))));
      yKey = Y_PK;
    } else {
      Y = entity[0];
      yKey = pk[0];
    }
    X = bytes32(ep.registerNumberedEntity(_board(vm.addr(OLD_PK))));
    xIsLeft = X < Y;
    assertEq(xIsLeft, !xRight, "entity order");

    // 1000 reserve each; Left puts 100 into the Account.
    dep.mintToReserve(X, T, 1_000);
    dep.mintToReserve(Y, T, 1_000);
    (bytes32 left, uint256 leftKey, bytes32 right) = xIsLeft ? (X, OLD_PK, Y) : (Y, yKey, X);
    Batch memory fund = XlnHanko.emptyBatch();
    fund.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({entity: right, amount: 100});
    fund.reserveToCollateral[0] = ReserveToCollateral({tokenId: T, receivingEntity: left, pairs: pairs});
    _submitAs(left, leftKey, fund);

    _rotate(vm.addr(NEW_PK));
    epoch = dep.ondeltaEpoch(X, Y);
  }

  // ───────────────────────── plumbing ─────────────────────────

  function _board(address member) internal pure returns (bytes memory) {
    bytes32[] memory members = new bytes32[](1);
    members[0] = bytes32(uint256(uint160(member)));
    uint16[] memory powers = new uint16[](1);
    powers[0] = 1;
    return abi.encode(Board({
      votingThreshold: 1, entityIds: members, votingPowers: powers,
      boardChangeDelay: 0, controlChangeDelay: 0, dividendChangeDelay: 0
    }));
  }

  function _hankoAs(bytes32 entityId, uint256 key, bytes32 hash) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
    return XlnHanko.encodeSingleSignerHanko(entityId, v, r, s);
  }

  function _submitAs(bytes32 entityId, uint256 key, Batch memory batch) internal {
    bytes memory encoded = abi.encode(batch);
    uint256 nonce = dep.entityNonces(entityId) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entityId, encoded, nonce);
    dep.processBatch(entityId, encoded, _hankoAs(entityId, key, h), nonce);
  }

  /// @dev Rotate X's board to `next` (same entity id); the old board stays valid evidence for seven days.
  function _rotate(address next) internal {
    bytes memory encodedNext = _board(next);
    bytes32 nextHash = ep.commitBoard(encodedNext);
    uint256 actionNonce = ep.boardActionNonces(X) + 1;
    bytes32 proposal = ep.computeBoardProposalHash(X, nextHash, ProposerType.BOARD, actionNonce);
    bytes[] memory auth = new bytes[](1);
    auth[0] = _hankoAs(X, OLD_PK, proposal);
    ep.proposeBoard(X, nextHash, ProposerType.BOARD, auth);
    vm.warp(block.timestamp + 1 days); // the BOARD lane waits controlDelay
    ep.activateBoard(X);
    rotatedAt = block.timestamp;
  }

  function _body(int256 offdelta) internal pure returns (ProofBody memory pb) {
    pb.watchSeed = keccak256("h3");
    pb.leftResponseSeconds = 60;
    pb.rightResponseSeconds = 60;
    pb.offdeltas = new Int512[](1);
    pb.offdeltas[0] = WideMath.fromInt(offdelta);
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = T;
    pb.transformers = new TransformerClause[](0);
  }

  /// @dev Y opens against X with a proof at nonce 1 authored by X and signed by `signerKey`, waits both windows and times
  ///      its own dispute out. Returns (X reserve, Y reserve, collateral, Y's outstanding debt to X).
  function _yStarts(uint256 signerKey, int256 offdelta)
    internal returns (uint256 xr, uint256 yr, uint256 col)
  {
    ProofBody memory pb = _body(offdelta);
    bytes32 pbHash = keccak256(abi.encode(pb));
    bytes memory key = XlnHanko.accountKey(X, Y);
    bytes32 signed = XlnHanko.disputeProofHashAtEpoch(address(dep), key, epoch, 1, xIsLeft, pbHash, pb.watchSeed);

    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof({
      counterentity: X, nonce: 1, ondeltaEpoch: epoch, proposerIsLeft: xIsLeft, proofbodyHash: pbHash, initialProofbody: pb,
      watchSeed: pb.watchSeed, sig: _hankoAs(X, signerKey, signed),
      starterInitialArguments: "", starterCounterArguments: "", starterCounterProofCommitment: bytes32(0)
    });
    vm.warp(rotatedAt + 10);
    _submitAs(Y, yKey, start);

    vm.warp(rotatedAt + 140);
    Batch memory fin = XlnHanko.emptyBatch();
    fin.disputeFinalizations = new FinalDisputeProof[](1);
    fin.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: X, initialNonce: 1, finalNonce: 1, proposerIsLeft: xIsLeft, initialProofbodyHash: pbHash,
      finalProofbody: pb, starterArguments: "", otherArguments: "", sig: "",
      startedByLeft: !xIsLeft, cooperative: false
    });
    _submitAs(Y, yKey, fin);

    xr = dep._reserves(X, T);
    yr = dep._reserves(Y, T);
    (col, ) = dep._collaterals(key, T);
  }
}

/// @notice X is Left (Y lazy). Left funds the collateral, so X holds 900 and Y 1000 before the dispute.
contract RetiredBoardH3LeftTest is RetiredBoardH3Base {
  function setUp() public {
    _setUpWorld(false);
  }

  function test_h3_retiredLeftOwingBeyondCollateralPaysOnlyTheCollateral() public {
    // delta = 100 - 500 = -400: Left X would owe Y 400 beyond its collateral, from reserves. Retired evidence caps it.
    (uint256 xr, uint256 yr, uint256 col) = _yStarts(OLD_PK, -500);
    assertEq(xr, 900, "X reserves untouched");
    assertEq(yr, 1_100, "Y gets only the collateral");
    assertEq(col, 0);
    assertEq(dep.activeDebts(X), 0, "no debt is booked against the retired side");
  }

  function test_h3_currentBoardEvidenceSettlesInFull() public {
    (uint256 xr, uint256 yr, ) = _yStarts(NEW_PK, -500);
    assertEq(xr, 500, "current board pays from reserves");
    assertEq(yr, 1_500);
  }

  function test_h3_leftOwedBeyondCollateralIsNeverClamped() public {
    // delta = 100 + 500 = 600: Right Y owes Left X 500 beyond the collateral. X must be paid in full.
    (uint256 xr, uint256 yr, ) = _yStarts(OLD_PK, 500);
    assertEq(xr, 1_500);
    assertEq(yr, 500);
  }

  function test_h3_retiredEvidenceInsideTheCollateralIsHonouredExactly() public {
    // delta = 100 - 30 = 70: X gets 70 of the 100 back, Y gets 30.
    (uint256 xr, uint256 yr, ) = _yStarts(OLD_PK, -30);
    assertEq(xr, 970);
    assertEq(yr, 1_030);
  }
}

/// @notice X is Right (Y registered first, so Y is Left). Y funds the collateral: Y holds 900, X 1000 before the dispute.
contract RetiredBoardH3RightTest is RetiredBoardH3Base {
  function setUp() public {
    _setUpWorld(true);
  }

  function test_h3_retiredRightOwingBeyondCollateralPaysOnlyTheCollateral() public {
    // Y is Left with 100 collateral; delta = 600: Right X would owe Y 500 beyond the collateral, from reserves.
    (uint256 xr, uint256 yr, uint256 col) = _yStarts(OLD_PK, 500);
    assertEq(xr, 1_000, "X reserves untouched");
    assertEq(yr, 1_000, "Y gets only its collateral back");
    assertEq(col, 0);
    assertEq(dep.activeDebts(X), 0, "no debt is booked against the retired side");
  }

  function test_h3_currentBoardEvidenceSettlesInFull() public {
    (uint256 xr, uint256 yr, ) = _yStarts(NEW_PK, 500);
    assertEq(xr, 500, "current board pays from reserves");
    assertEq(yr, 1_500);
  }

  function test_h3_rightOwedIsNeverClamped() public {
    // Y is Left with 100 collateral; delta = 100 - 500 = -400: Left Y owes Right X 400 beyond it. X must be paid in full.
    (uint256 xr, uint256 yr, ) = _yStarts(OLD_PK, -500);
    assertEq(xr, 1_500);
    assertEq(yr, 500);
  }
}
