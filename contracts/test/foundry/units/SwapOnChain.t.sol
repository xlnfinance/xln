// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "../helpers/XlnFixture.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import {DeltaTransformer} from "../../../contracts/DeltaTransformer.sol";
import "../../../contracts/Types.sol";
import {WideMath} from "../../../contracts/math/WideMath.sol";

/// R-SWAP-ONCHAIN: a two-party swap inside an Account, run through a real dispute finalize on the deployed contracts. The maker
/// signs a Swap clause (give ADD of token 1 for SUB of token 2); the taker, as the non-starter, picks the fill ratio at finalize.
/// Every expected number is a literal worked out by hand: fill = floor(amount * ratio / 65535) on each leg, rounded on its own.
contract SwapOnChainTest is XlnFixture {
  uint256 internal constant GIVE_TOKEN = 1;
  uint256 internal constant WANT_TOKEN = 2;
  uint256 internal constant C = 1_000_000; // collateral of each token, deposited by the side that owns its giving end
  uint16 internal constant FULL = 65_535;

  function setUp() public { _deployXln(); }

  function _leftActor() internal view returns (uint256) { return entity[0] < entity[1] ? 0 : 1; }

  function _accountNonce(bytes32 a, bytes32 b) internal view returns (uint256 n) {
    (n, , , , , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(a, b));
  }

  function _disputeHashOf(bytes32 a, bytes32 b) internal view returns (bytes32 h) {
    (, h, , , , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(a, b));
  }

  function _collateralOf(bytes32 a, bytes32 b, uint256 t) internal view returns (uint256 c) {
    (c,) = dep._collaterals(XlnHanko.accountKey(a, b), t);
  }

  /// @dev `actor` funds `amount` of `tokenId` into collateral with `peer`.
  function _fund(uint256 actor, uint256 peer, uint256 tokenId, uint256 amount) internal {
    dep.mintToReserve(entity[actor], tokenId, amount);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: entity[peer], amount: amount });
    b.reserveToCollateral[0] = ReserveToCollateral({ tokenId: tokenId, receivingEntity: entity[actor], pairs: pairs });
    assertTrue(_submit(actor, b));
  }

  /// @dev The maker owns the give token's collateral and the taker owns the want token's, so each leg of the swap has something to move.
  function _fundBoth(uint256 maker, uint256 taker) internal {
    _fund(maker, taker, GIVE_TOKEN, C);
    _fund(taker, maker, WANT_TOKEN, C);
  }

  /// @dev Allowances a swap needs, in the direction the swap moves each delta (a delta is Left's allocation). A left maker lowers the
  ///      give delta (right allowance) and raises the want delta (left allowance); a right maker is the mirror image.
  function _allowances(bool makerIsLeft, uint256 give, uint256 want, bool withGiveAllowance, bool withWantAllowance)
    internal pure returns (Allowance[] memory out)
  {
    out = new Allowance[]((withGiveAllowance ? 1 : 0) + (withWantAllowance ? 1 : 0));
    uint256 i = 0;
    if (withGiveAllowance) out[i++] = Allowance({ deltaIndex: 0, rightAllowance: makerIsLeft ? give : 0, leftAllowance: makerIsLeft ? 0 : give });
    if (withWantAllowance) out[i++] = Allowance({ deltaIndex: 1, rightAllowance: makerIsLeft ? 0 : want, leftAllowance: makerIsLeft ? want : 0 });
  }

  function _proofBody(bool makerIsLeft, uint256 give, uint256 want, bool withGiveAllowance, bool withWantAllowance)
    internal view returns (ProofBody memory)
  {
    return _proofBodyWith(_oneSwap(makerIsLeft, give, want), _allowances(makerIsLeft, give, want, withGiveAllowance, withWantAllowance));
  }

  function _oneSwap(bool makerIsLeft, uint256 give, uint256 want) internal pure returns (DeltaTransformer.Swap[] memory swaps) {
    swaps = new DeltaTransformer.Swap[](1);
    swaps[0] = DeltaTransformer.Swap({ ownerIsLeft: makerIsLeft, addDeltaIndex: 0, addAmount: give, subDeltaIndex: 1, subAmount: want });
  }

  function _proofBodyWith(DeltaTransformer.Swap[] memory swaps, Allowance[] memory allowances) internal view returns (ProofBody memory pb) {
    pb.watchSeed = keccak256("swap-onchain");
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.offdeltas = new Int512[](2);
    pb.tokenIds = new uint256[](2);
    pb.tokenIds[0] = GIVE_TOKEN;
    pb.tokenIds[1] = WANT_TOKEN;
    DeltaTransformer.Batch memory tb;
    tb.swap = swaps;
    pb.transformers = new TransformerClause[](1);
    pb.transformers[0] = TransformerClause({
      transformerAddress: address(deltaTransformer),
      encodedBatch: deltaTransformer.encodeBatch(tb),
      allowances: allowances
    });
  }

  /// @dev The maker starts the dispute with the state the taker signed.
  function _start(uint256 maker, uint256 taker, ProofBody memory pb) internal returns (uint256 nonce, bytes32 hash) {
    return _startBy(maker, taker, pb, "");
  }

  /// @dev `starter` starts the dispute with the state `signer` signed; `starterArgs` are committed at the start.
  function _startBy(uint256 starter, uint256 signer, ProofBody memory pb, bytes memory starterArgs)
    internal returns (uint256 nonce, bytes32 hash)
  {
    hash = keccak256(abi.encode(pb));
    nonce = _accountNonce(entity[starter], entity[signer]) + 1;
    bool proposerIsLeft = entity[signer] < entity[starter];
    bytes memory key = XlnHanko.accountKey(entity[starter], entity[signer]);
    bytes32 signed_ = XlnHanko.disputeProofHash(address(dep), key, nonce, proposerIsLeft, hash, pb.watchSeed);
    Batch memory b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[signer], nonce: nonce, ondeltaEpoch: XlnHanko.currentEpoch(address(dep), key),
      proposerIsLeft: proposerIsLeft, proofbodyHash: hash, initialProofbody: pb, watchSeed: pb.watchSeed,
      sig: _hanko(signer, signed_), starterInitialArguments: starterArgs, starterCounterArguments: "", starterCounterProofCommitment: bytes32(0)
    });
    assertTrue(_submit(starter, b));
  }

  /// @dev The taker's argument blob for the one clause: the wrapper `bytes[]`, one entry per clause, each an `Arguments`.
  function _takerArguments(uint16 ratio) internal pure returns (bytes memory) {
    uint16[] memory ratios = new uint16[](1);
    ratios[0] = ratio;
    return _takerArgumentsList(ratios);
  }

  /// @dev The same for a clause holding several swaps of one owner: the n-th ratio is for the n-th such swap.
  function _takerArgumentsList(uint16[] memory ratios) internal pure returns (bytes memory) {
    bytes[] memory perClause = new bytes[](1);
    perClause[0] = abi.encode(DeltaTransformer.Arguments({ fillRatios: ratios, secrets: new bytes32[](0) }));
    return abi.encode(perClause);
  }

  function _finalizeBatch(uint256 maker, uint256 taker, uint256 nonce, bytes32 hash, ProofBody memory pb, bytes memory takerArgs)
    internal view returns (Batch memory b)
  {
    return _finalizeBatchBy(maker, taker, nonce, hash, pb, "", takerArgs);
  }

  /// @dev The finalize of a dispute that `starter` started on a state `signer` signed: the starter's arguments must be the committed ones.
  function _finalizeBatchBy(
    uint256 starter, uint256 signer, uint256 nonce, bytes32 hash, ProofBody memory pb, bytes memory starterArgs, bytes memory otherArgs
  ) internal view returns (Batch memory b) {
    b = XlnHanko.emptyBatch();
    b.disputeFinalizations = new FinalDisputeProof[](1);
    b.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: entity[starter], initialNonce: nonce, finalNonce: nonce, proposerIsLeft: entity[signer] < entity[starter],
      initialProofbodyHash: hash, finalProofbody: pb, starterArguments: starterArgs, otherArguments: otherArgs, sig: "",
      startedByLeft: entity[starter] < entity[signer], cooperative: false
    });
  }

  /// @dev Fund, start (maker), finalize at once (taker accepts the exact state and supplies its fill).
  function _swap(bool makerIsLeft, uint256 give, uint256 want, bytes memory takerArgs)
    internal returns (uint256 maker, uint256 taker)
  {
    maker = makerIsLeft ? _leftActor() : 1 - _leftActor();
    taker = 1 - maker;
    _fundBoth(maker, taker);
    ProofBody memory pb = _proofBody(makerIsLeft, give, want, true, true);
    (uint256 nonce, bytes32 hash) = _start(maker, taker, pb);
    assertTrue(_disputeHashOf(entity[maker], entity[taker]) != bytes32(0), "dispute open");
    assertTrue(_submit(taker, _finalizeBatch(maker, taker, nonce, hash, pb, takerArgs)), "taker finalizes with its fill");
    assertEq(_disputeHashOf(entity[maker], entity[taker]), bytes32(0), "dispute closed");
  }

  /// @dev Settled custody: the maker keeps what it did not give and gets what it was owed, the taker mirrors it, and nothing is left behind.
  function _assertSettled(uint256 maker, uint256 taker, uint256 gave, uint256 got) internal view {
    assertEq(dep._reserves(entity[maker], GIVE_TOKEN), C - gave, "maker keeps the unfilled part of the give token");
    assertEq(dep._reserves(entity[taker], GIVE_TOKEN), gave, "taker receives the give leg");
    assertEq(dep._reserves(entity[maker], WANT_TOKEN), got, "maker receives the want leg");
    assertEq(dep._reserves(entity[taker], WANT_TOKEN), C - got, "taker keeps the unfilled part of the want token");
    assertEq(_collateralOf(entity[maker], entity[taker], GIVE_TOKEN), 0, "give collateral released");
    assertEq(_collateralOf(entity[maker], entity[taker], WANT_TOKEN), 0, "want collateral released");
    assertEq(dep.activeDebts(entity[maker]) + dep.activeDebts(entity[taker]), 0, "a priced fill leaves no debt");
  }

  // ─────────────── partial fill at a nonzero ratio ───────────────

  /// Order 1000 for 333 at 32768/65535: give floor(1000*32768/65535)=500, want floor(333*32768/65535)=166 (the exact half, 166.5, rounds down).
  function test_R_SWAP_ONCHAIN_partialFillLeftMaker() public {
    (uint256 maker, uint256 taker) = _swap(true, 1000, 333, _takerArguments(32_768));
    _assertSettled(maker, taker, 500, 166);
  }

  /// The same order with the maker on the right: the taker's ratio then travels as the left side's argument.
  function test_R_SWAP_ONCHAIN_partialFillRightMaker() public {
    (uint256 maker, uint256 taker) = _swap(false, 1000, 333, _takerArguments(32_768));
    _assertSettled(maker, taker, 500, 166);
  }

  function test_R_SWAP_ONCHAIN_fullFillMovesTheWholeOrder() public {
    (uint256 maker, uint256 taker) = _swap(true, 1000, 333, _takerArguments(FULL));
    _assertSettled(maker, taker, 1000, 333);
  }

  // ─────────────── rounding on each leg ───────────────

  /// Order 1000 for 3 at 10000/65535: give floor(10_000_000/65535)=152, want floor(30_000/65535)=0. The legs round on their own, so the
  /// maker can give up value for nothing: the Account must size a lot so that its want leg does not round to zero.
  function test_R_SWAP_ONCHAIN_legsRoundDownIndependentlyMakerGivesForNothing() public {
    (uint256 maker, uint256 taker) = _swap(true, 1000, 3, _takerArguments(10_000));
    _assertSettled(maker, taker, 152, 0);
  }

  /// Order 3 for 1000 at 10000/65535: give floor(30_000/65535)=0, want floor(10_000_000/65535)=152. The mirror image.
  function test_R_SWAP_ONCHAIN_legsRoundDownIndependentlyTakerPaysForNothing() public {
    (uint256 maker, uint256 taker) = _swap(true, 3, 1000, _takerArguments(10_000));
    _assertSettled(maker, taker, 0, 152);
  }

  /// One unit of ratio on an order of 65535 is exactly 1 of each leg: the divisor is 65535, not 65536.
  function test_R_SWAP_ONCHAIN_oneUnitOfRatioOnAnOrderOf65535IsOneOfEachLeg() public {
    (uint256 maker, uint256 taker) = _swap(true, 65_535, 65_535, _takerArguments(1));
    _assertSettled(maker, taker, 1, 1);
  }

  /// One unit short of that order, floor(65534 * 1 / 65535) = 0 on both legs: the ratio never rounds up.
  function test_R_SWAP_ONCHAIN_oneUnitOfRatioOnAnOrderOf65534IsZeroOfEachLeg() public {
    (uint256 maker, uint256 taker) = _swap(true, 65_534, 65_534, _takerArguments(1));
    _assertSettled(maker, taker, 0, 0);
  }

  // ─────────────── 0% fill ───────────────

  function test_R_SWAP_ONCHAIN_zeroRatioMovesNothing() public {
    (uint256 maker, uint256 taker) = _swap(true, 1000, 333, _takerArguments(0));
    _assertSettled(maker, taker, 0, 0);
  }

  /// The taker who says nothing takes nothing: no argument at all is a 0% fill, and the dispute still closes.
  function test_R_SWAP_ONCHAIN_noArgumentIsZeroFill() public {
    (uint256 maker, uint256 taker) = _swap(true, 1000, 333, "");
    _assertSettled(maker, taker, 0, 0);
  }

  /// Garbage in the taker's argument is a 0% fill, never a revert that would hold the Account hostage.
  function test_R_SWAP_ONCHAIN_malformedArgumentIsZeroFill() public {
    (uint256 maker, uint256 taker) = _swap(true, 1000, 333, hex"deadbeef");
    _assertSettled(maker, taker, 0, 0);
  }

  // ─────────────── a missing allowance reverts the whole finalize ───────────────

  /// A nonzero fill that changes a delta with no Allowance reverts the finalize; the dispute stays open and no custody moves.
  function _assertMissingAllowanceRevertsWhole(bool withGiveAllowance, bool withWantAllowance) internal {
    uint256 maker = _leftActor();
    uint256 taker = 1 - maker;
    _fundBoth(maker, taker);
    ProofBody memory pb = _proofBody(true, 1000, 333, withGiveAllowance, withWantAllowance);
    (uint256 nonce, bytes32 hash) = _start(maker, taker, pb);
    bytes memory encoded = abi.encode(_finalizeBatch(maker, taker, nonce, hash, pb, _takerArguments(32_768)));
    uint256 batchNonce = dep.entityNonces(entity[taker]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[taker], encoded, batchNonce);
    bytes memory hanko = _hanko(taker, h);
    bytes32 openDispute = _disputeHashOf(entity[maker], entity[taker]);

    vm.expectRevert(abi.encodeWithSignature("TransformerExecutionFailed()"));
    dep.processBatch(entity[taker], encoded, hanko, batchNonce);

    assertEq(_disputeHashOf(entity[maker], entity[taker]), openDispute, "the dispute stays open");
    assertEq(dep.entityNonces(entity[taker]), batchNonce - 1, "the taker's nonce is not spent");
    assertEq(_collateralOf(entity[maker], entity[taker], GIVE_TOKEN), C, "give collateral untouched");
    assertEq(_collateralOf(entity[maker], entity[taker], WANT_TOKEN), C, "want collateral untouched");
    assertEq(dep._reserves(entity[maker], GIVE_TOKEN) + dep._reserves(entity[taker], GIVE_TOKEN), 0, "no reserve paid out");
    assertEq(dep._reserves(entity[maker], WANT_TOKEN) + dep._reserves(entity[taker], WANT_TOKEN), 0, "no reserve paid out");
  }

  function test_R_SWAP_ONCHAIN_missingAllowanceOnTheWantLegRevertsWholeFinalize() public {
    _assertMissingAllowanceRevertsWhole(true, false);
  }

  function test_R_SWAP_ONCHAIN_missingAllowanceOnTheGiveLegRevertsWholeFinalize() public {
    _assertMissingAllowanceRevertsWhole(false, true);
  }

  function test_R_SWAP_ONCHAIN_noAllowanceAtAllRevertsWholeFinalize() public {
    _assertMissingAllowanceRevertsWhole(false, false);
  }

  // ─────────────── an Allowance below the fill caps the delta (clamp, not revert) ───────────────

  function _leftMakerSwap(uint256 give, uint256 want, Allowance[] memory allowances, bytes memory takerArgs)
    internal returns (uint256 maker, uint256 taker)
  {
    maker = _leftActor();
    taker = 1 - maker;
    _fundBoth(maker, taker);
    ProofBody memory pb = _proofBodyWith(_oneSwap(true, give, want), allowances);
    (uint256 nonce, bytes32 hash) = _startBy(maker, taker, pb, "");
    assertTrue(_submit(taker, _finalizeBatch(maker, taker, nonce, hash, pb, takerArgs)), "taker finalizes with its fill");
  }

  function _giveAndWantAllowances(uint256 giveRight, uint256 giveLeft, uint256 wantRight, uint256 wantLeft)
    internal pure returns (Allowance[] memory out)
  {
    out = new Allowance[](2);
    out[0] = Allowance({ deltaIndex: 0, rightAllowance: giveRight, leftAllowance: giveLeft });
    out[1] = Allowance({ deltaIndex: 1, rightAllowance: wantRight, leftAllowance: wantLeft });
  }

  /// The allowance is the maker's loss limit: a full fill of 1000 against a give allowance of 400 moves 400, the want leg still moves its 333.
  function test_R_SWAP_ONCHAIN_giveAllowanceBelowTheFillCapsWhatTheMakerGives() public {
    (uint256 maker, uint256 taker) = _leftMakerSwap(1000, 333, _giveAndWantAllowances(400, 0, 0, 333), _takerArguments(FULL));
    _assertSettled(maker, taker, 400, 333);
  }

  /// The want leg is capped on its own: a want allowance of 100 against a fill of 333 gives the maker 100, the give leg still moves its 1000.
  function test_R_SWAP_ONCHAIN_wantAllowanceBelowTheFillCapsWhatTheMakerReceives() public {
    (uint256 maker, uint256 taker) = _leftMakerSwap(1000, 333, _giveAndWantAllowances(1000, 0, 0, 100), _takerArguments(FULL));
    _assertSettled(maker, taker, 1000, 100);
  }

  /// An allowance on the wrong side of a delta allows no movement that way: the give leg of a left maker lowers the delta, so a left-side
  /// allowance (which only raises it) clamps the give leg to nothing, the want leg (right way round) moves its 333.
  function test_R_SWAP_ONCHAIN_allowanceInTheWrongDirectionMovesNothing() public {
    (uint256 maker, uint256 taker) = _leftMakerSwap(1000, 333, _giveAndWantAllowances(0, 1000, 0, 333), _takerArguments(FULL));
    _assertSettled(maker, taker, 0, 333);
  }

  // ─────────────── several swaps of one owner in a clause: the n-th ratio is for the n-th swap ───────────────

  function _twoSwaps(bool makerIsLeft, uint16 firstRatio, uint16 secondRatio) internal returns (uint256 maker, uint256 taker) {
    maker = makerIsLeft ? _leftActor() : 1 - _leftActor();
    taker = 1 - maker;
    _fundBoth(maker, taker);
    DeltaTransformer.Swap[] memory swaps = new DeltaTransformer.Swap[](2);
    swaps[0] = DeltaTransformer.Swap({ ownerIsLeft: makerIsLeft, addDeltaIndex: 0, addAmount: 1000, subDeltaIndex: 1, subAmount: 300 });
    swaps[1] = DeltaTransformer.Swap({ ownerIsLeft: makerIsLeft, addDeltaIndex: 0, addAmount: 500, subDeltaIndex: 1, subAmount: 100 });
    ProofBody memory pb = _proofBodyWith(swaps, _allowances(makerIsLeft, 1500, 400, true, true));
    (uint256 nonce, bytes32 hash) = _startBy(maker, taker, pb, "");
    uint16[] memory ratios = new uint16[](2);
    ratios[0] = firstRatio;
    ratios[1] = secondRatio;
    assertTrue(_submit(taker, _finalizeBatch(maker, taker, nonce, hash, pb, _takerArgumentsList(ratios))), "taker finalizes with its fills");
  }

  function test_R_SWAP_ONCHAIN_twoSwapsLeftMakerTheFirstFillsAndTheSecondDoesNot() public {
    (uint256 maker, uint256 taker) = _twoSwaps(true, FULL, 0);
    _assertSettled(maker, taker, 1000, 300);
  }

  function test_R_SWAP_ONCHAIN_twoSwapsLeftMakerTheSecondFillsAndTheFirstDoesNot() public {
    (uint256 maker, uint256 taker) = _twoSwaps(true, 0, FULL);
    _assertSettled(maker, taker, 500, 100);
  }

  function test_R_SWAP_ONCHAIN_twoSwapsRightMakerTheFirstFillsAndTheSecondDoesNot() public {
    (uint256 maker, uint256 taker) = _twoSwaps(false, FULL, 0);
    _assertSettled(maker, taker, 1000, 300);
  }

  function test_R_SWAP_ONCHAIN_twoSwapsRightMakerTheSecondFillsAndTheFirstDoesNot() public {
    (uint256 maker, uint256 taker) = _twoSwaps(false, 0, FULL);
    _assertSettled(maker, taker, 500, 100);
  }

  // ─────────────── the taker is the dispute starter: its ratio is committed at the start ───────────────

  function _takerStarts(bool makerIsLeft, uint16 committed, uint16 shown) internal returns (uint256 maker, uint256 taker, bytes memory encoded, bytes32 openDispute) {
    maker = makerIsLeft ? _leftActor() : 1 - _leftActor();
    taker = 1 - maker;
    _fundBoth(maker, taker);
    ProofBody memory pb = _proofBody(makerIsLeft, 1000, 333, true, true);
    (uint256 nonce, bytes32 hash) = _startBy(taker, maker, pb, _takerArguments(committed));
    encoded = abi.encode(_finalizeBatchBy(taker, maker, nonce, hash, pb, _takerArguments(shown), ""));
    openDispute = _disputeHashOf(entity[maker], entity[taker]);
  }

  function _makerFinalizes(uint256 maker, bytes memory encoded) internal {
    (uint256 batchNonce, bytes memory hanko) = _signedBatch(maker, encoded);
    dep.processBatch(entity[maker], encoded, hanko, batchNonce);
  }

  function _signedBatch(uint256 actor, bytes memory encoded) internal view returns (uint256 batchNonce, bytes memory hanko) {
    batchNonce = dep.entityNonces(entity[actor]) + 1;
    hanko = _hanko(actor, XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[actor], encoded, batchNonce));
  }

  /// The taker starts on the state the maker signed and commits 32768/65535; the maker, as the non-starter, accepts the exact state at once.
  function test_R_SWAP_ONCHAIN_takerWhoStartsFillsAtTheRatioItCommittedLeftMaker() public {
    (uint256 maker, uint256 taker, bytes memory encoded,) = _takerStarts(true, 32_768, 32_768);
    _makerFinalizes(maker, encoded);
    _assertSettled(maker, taker, 500, 166);
  }

  function test_R_SWAP_ONCHAIN_takerWhoStartsFillsAtTheRatioItCommittedRightMaker() public {
    (uint256 maker, uint256 taker, bytes memory encoded,) = _takerStarts(false, 32_768, 32_768);
    _makerFinalizes(maker, encoded);
    _assertSettled(maker, taker, 500, 166);
  }

  /// The maker cannot swap in another ratio for the one the taker committed: the starter's arguments are checked against the start.
  function test_R_SWAP_ONCHAIN_aRatioOtherThanTheCommittedOneIsRefused() public {
    (uint256 maker, uint256 taker, bytes memory encoded, bytes32 openDispute) = _takerStarts(true, 32_768, 0);
    (uint256 batchNonce, bytes memory hanko) = _signedBatch(maker, encoded);
    vm.expectRevert(IDepositoryDelegateErrorAbi.E9.selector);
    dep.processBatch(entity[maker], encoded, hanko, batchNonce);
    assertEq(_disputeHashOf(entity[maker], entity[taker]), openDispute, "the dispute stays open");
  }

  // ─────────────── what the contract does not know: an off-chain fill ───────────────

  /// The contract keeps no memory of an off-chain fill. A state whose offdeltas already hold a fill of 500 and 166, signed with the clause
  /// still in it, fills again at the dispute: the maker ends up giving 1500. So the Account must drop or shrink the clause in the same
  /// frame that moves the offdeltas (Runtime/Account duty), and this test is the on-chain evidence for that rule.
  function test_R_SWAP_ONCHAIN_aClauseLeftInAStateThatAlreadyHoldsTheFillFillsAgain() public {
    uint256 maker = _leftActor();
    uint256 taker = 1 - maker;
    _fundBoth(maker, taker);
    ProofBody memory pb = _proofBody(true, 1000, 333, true, true);
    pb.offdeltas[0] = WideMath.fromInt(-500);
    pb.offdeltas[1] = WideMath.fromInt(166);
    (uint256 nonce, bytes32 hash) = _startBy(maker, taker, pb, "");
    assertTrue(_submit(taker, _finalizeBatch(maker, taker, nonce, hash, pb, _takerArguments(FULL))), "taker finalizes with its fill");
    _assertSettled(maker, taker, 1500, 499);
  }
}
