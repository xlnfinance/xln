// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import "../../../contracts/Depository.sol";
import "../../../contracts/EntityProvider.sol";
import {ERC20Mock} from "../../../contracts/ERC20Mock.sol";
import "../../../contracts/Types.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";

/// @notice Stateful handler for DepositoryConservation.invariants.t.sol.
///
/// Differences from DepositoryHandler (the pattern this extends):
/// - `mixedBatch` submits MULTI-item batches: several R2R/R2C legs, an
///   optional C2R, an optional settlement, several deposits/withdrawals and
///   an optional implicit-flash overdraw (an R2R leg above the spendable
///   reserve, legal only for a debt-free initiator that is repaid by a later
///   C2R/settlement leg), all in one processBatch. The per-batch conservation
///   oracle therefore sees composed orderings, not single ops.
/// - every accepted submission is nonce-ghosted (`ghostEntityNonce`) and its
///   exact (encoded, hanko, nonce) triple is retained for `replayLast`, so
///   replay-resistance is exercised under any call order the fuzzer picks.
contract ConservationHandler is CommonBase, StdCheats, StdUtils {
  uint256 public constant ACTORS = 4;

  Depository public immutable dep;
  ERC20Mock public immutable tokenA; // internal id 1
  ERC20Mock public immutable tokenB; // internal id 2
  address public immutable admin;

  uint256[3] public TOKENS = [uint256(1), uint256(2), uint256(3)];

  uint256[ACTORS] internal pk;
  bytes32[ACTORS] public entityOf;

  // ── ghost accounting ──
  mapping(uint256 => uint256) public ghostMinted; // tokenId => admin-minted total
  mapping(uint256 => uint256) public ghostEntityNonce; // actorIndex => accepted entity nonce

  // ── handler-side oracles ──
  /// @dev Per accepted batch: Δ(Σreserves+Σcollateral) per token must equal the
  ///      exact external-token balance delta the Depository saw (0 for token 3).
  uint256 public batchValueViolations;
  /// @dev entityNonces moved by anything other than exactly +1 on accept,
  ///      or moved at all on reject.
  uint256 public nonceViolations;
  /// @dev An exact (bytes, hanko, nonce) replay of an accepted batch succeeded.
  uint256 public replayViolations;
  uint256 public replayAttempts;

  // coverage counters
  uint256 public acceptedBatches;
  uint256 public rejectedBatches;
  mapping(bytes32 => uint256) public calls;

  // last accepted submission per actor, for replay
  mapping(uint256 => bytes) internal lastEncoded;
  mapping(uint256 => bytes) internal lastHanko;
  mapping(uint256 => uint256) internal lastNonce;

  constructor(
    Depository _dep,
    ERC20Mock _a,
    ERC20Mock _b,
    uint256[ACTORS] memory _pk,
    address _admin
  ) {
    dep = _dep;
    tokenA = _a;
    tokenB = _b;
    admin = _admin;
    for (uint256 i = 0; i < ACTORS; i++) {
      pk[i] = _pk[i];
      entityOf[i] = XlnHanko.lazyEntityId(vm.addr(_pk[i]));
    }
  }

  // ═══════════════════════════ helpers ═══════════════════════════

  function _actor(uint256 seed) internal pure returns (uint256) {
    return seed % ACTORS;
  }

  function _token(uint256 seed) internal view returns (uint256) {
    return TOKENS[seed % 3];
  }

  function _distinct(uint256 seedA, uint256 seedB) internal pure returns (uint256 a, uint256 b) {
    a = _actor(seedA);
    b = _actor(seedB);
    if (a == b) b = (b + 1) % ACTORS;
  }

  function _bump(string memory name) internal {
    calls[keccak256(bytes(name))]++;
  }

  function callCount(string memory name) external view returns (uint256) {
    return calls[keccak256(bytes(name))];
  }

  function _hanko(uint256 actor, bytes32 hash) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk[actor], hash);
    return XlnHanko.encodeSingleSignerHanko(entityOf[actor], v, r, s);
  }

  function _reserve(uint256 actor, uint256 tokenId) internal view returns (uint256) {
    return dep._reserves(entityOf[actor], tokenId);
  }

  function _spendable(uint256 actor, uint256 tokenId) internal view returns (uint256) {
    uint256 r = _reserve(actor, tokenId);
    uint256 d = dep.debtOutstanding(entityOf[actor], tokenId);
    return r > d ? r - d : 0;
  }

  function _collateral(bytes32 e1, bytes32 e2, uint256 tokenId) internal view returns (uint256 c) {
    (c,) = dep._collaterals(XlnHanko.accountKey(e1, e2), tokenId);
  }

  function _accountNonce(bytes32 e1, bytes32 e2) internal view returns (uint256 n) {
    (n, , , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(e1, e2));
  }

  function _totalInternal(uint256 tokenId) internal view returns (uint256 total) {
    for (uint256 i = 0; i < ACTORS; i++) {
      total += dep._reserves(entityOf[i], tokenId);
    }
    for (uint256 i = 0; i < ACTORS; i++) {
      for (uint256 j = i + 1; j < ACTORS; j++) {
        (uint256 c,) = dep._collaterals(XlnHanko.accountKey(entityOf[i], entityOf[j]), tokenId);
        total += c;
      }
    }
  }

  function _externalBalance(uint256 tokenId) internal view returns (uint256) {
    if (tokenId == 1) return tokenA.balanceOf(address(dep));
    if (tokenId == 2) return tokenB.balanceOf(address(dep));
    return 0;
  }

  /// @dev Records an accepted (encoded, hanko, nonce) triple with its +1 nonce
  ///      step, or verifies a rejection left the nonce untouched.
  function _recordSubmitOutcome(uint256 actor, uint256 nonce, bytes memory encoded, bytes memory hanko) internal {
    uint256 nowNonce = dep.entityNonces(entityOf[actor]);
    if (nowNonce != ghostEntityNonce[actor] + 1 || nowNonce != nonce) {
      nonceViolations++;
      return; // nonce oracle already fired; do not poison the replay triple
    }
    ghostEntityNonce[actor] = nowNonce;
    lastEncoded[actor] = encoded;
    lastHanko[actor] = hanko;
    lastNonce[actor] = nonce;
  }

  // ═══════════════════════════ actions ═══════════════════════════

  /// @notice Admin flash-funding; the only source of new internal value besides
  ///         external deposits, so it is fully ghost-tracked.
  function mint(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
    uint256 a = _actor(actorSeed);
    uint256 t = _token(tokenSeed);
    amount = bound(amount, 1, 1e24);
    vm.prank(admin);
    try dep.mintToReserve(entityOf[a], t, amount) {
      ghostMinted[t] += amount;
      _bump("mint");
    } catch {}
  }

  /// @notice The core action: one processBatch with a bounded-random
  ///         composition of money-moving legs. Amounts are bound to current
  ///         balances (+1) so both the legal and the over-spend path stay
  ///         reachable and acceptance stays common.
  function mixedBatch(
    uint256 actorSeed,
    uint256 s1,
    uint256 s2,
    uint256 s3,
    uint256 s4,
    uint256 s5,
    uint256 s6,
    uint256 s7
  ) external {
    uint256 a = _actor(actorSeed);
    uint256 nR2R = s1 % 3; // 0..2
    bool useC2R = s2 % 2 == 1;
    bool useSettle = s3 % 2 == 1;
    uint256 nDep = s4 % 3; // 0..2 external deposits
    uint256 nWdr = s5 % 3; // 0..2 external withdrawals
    bool overdraw = s6 % 3 == 0; // implicit flash: first R2R leg spends ahead of holding
    uint256 nR2C = s7 % 3; // 0..2
    if (overdraw && nR2R == 0) nR2R = 1;

    Batch memory b = XlnHanko.emptyBatch();

    // external deposits (increase reserves + external backing)
    if (nDep > 0) {
      b.externalTokenToReserve = new ExternalTokenToReserve[](nDep);
      for (uint256 i = 0; i < nDep; i++) {
        bool useA = (s3 + i) % 2 == 0;
        ERC20Mock tok = useA ? tokenA : tokenB;
        uint256 amount = bound(s4 + i, 1, 1e21);
        address caller = vm.addr(pk[a]);
        tok.mint(caller, amount);
        vm.prank(caller);
        tok.approve(address(dep), amount);
        // entity must stay inside the tracked actor set: entity == 0 would
        // credit the caller ADDRESS id, which the aggregation loops never see.
        (, uint256 to) = _distinct(a, s6 + i);
        b.externalTokenToReserve[i] = ExternalTokenToReserve({
          entity: entityOf[to],
          contractAddress: address(tok),
          externalTokenId: 0,
          tokenType: 0,
          internalTokenId: useA ? 1 : 2,
          amount: amount
        });
      }
    }

    // reserve-to-reserve legs
    if (nR2R > 0) {
      b.reserveToReserve = new ReserveToReserve[](nR2R);
      for (uint256 i = 0; i < nR2R; i++) {
        uint256 t = _token(s1 + i);
        (uint256 to,) = _distinct(a, s2 + i);
        uint256 amount = bound(s3 + i, 0, _spendable(a, t) + 1);
        if (overdraw && i == 0) amount = _spendable(a, t) + bound(s6, 1, 1e21);
        b.reserveToReserve[i] = ReserveToReserve({
          receivingEntity: entityOf[to],
          tokenId: t,
          amount: amount
        });
      }
    }

    // C2R shortcut (counterparty-signed collateral withdrawal)
    uint256 cpC2R = type(uint256).max;
    if (useC2R) {
      (, uint256 cp) = _distinct(a, s4);
      cpC2R = cp;
      uint256 t = _token(s5);
      uint256 col = _collateral(entityOf[a], entityOf[cp], t);
      uint256 amount = bound(s6, 0, col + 1);
      bool isLeft = entityOf[a] < entityOf[cp];
      int256 signedAmount = int256(amount);
      SettlementDiff[] memory diffs = new SettlementDiff[](1);
      diffs[0] = SettlementDiff({
        tokenId: t,
        leftDiff: isLeft ? signedAmount : int256(0),
        rightDiff: isLeft ? int256(0) : signedAmount,
        collateralDiff: -signedAmount,
        ondeltaDiff: isLeft ? -signedAmount : int256(0)
      });
      bytes memory key = XlnHanko.accountKey(entityOf[a], entityOf[cp]);
      uint256 acctNonce = _accountNonce(entityOf[a], entityOf[cp]) + 1;
      bytes32 h = XlnHanko.cooperativeUpdateHash(address(dep), key, acctNonce, diffs, new uint256[](0));
      b.collateralToReserve = new CollateralToReserve[](1);
      b.collateralToReserve[0] = CollateralToReserve({
        counterparty: entityOf[cp],
        tokenId: t,
        amount: amount,
        nonce: acctNonce,
        sig: _hanko(cp, h)
      });
    }

    // bilateral settlement; keep a pair distinct from the C2R pair so both
    // legs sign over their own next account nonce inside one batch
    if (useSettle) {
      (uint256 from, uint256 cp) = _distinct(a, s5);
      if (cp == cpC2R) {
        cp = (cp + 1) % ACTORS;
        if (cp == from) cp = (cp + 1) % ACTORS;
      }
      uint256 t = _token(s6);
      bytes32 me = entityOf[from];
      bytes32 other = entityOf[cp];
      (bytes32 left, bytes32 right) = me < other ? (me, other) : (other, me);
      int256 leftDiff = int256(bound(s7, 0, 2 * 1e20)) - 1e20; // -1e20..+1e20
      int256 collateralDiff = int256(bound(s1, 0, 2 * 1e20)) - 1e20;
      SettlementDiff[] memory diffs = new SettlementDiff[](1);
      diffs[0] = SettlementDiff({
        tokenId: t,
        leftDiff: leftDiff,
        rightDiff: -leftDiff - collateralDiff,
        collateralDiff: collateralDiff,
        ondeltaDiff: collateralDiff
      });
      bytes memory key = XlnHanko.accountKey(me, other);
      uint256 acctNonce = _accountNonce(me, other) + 1;
      bytes32 h = XlnHanko.cooperativeUpdateHash(address(dep), key, acctNonce, diffs, new uint256[](0));
      b.settlements = new Settlement[](1);
      b.settlements[0] = Settlement({
        leftEntity: left,
        rightEntity: right,
        diffs: diffs,
        forgiveDebtsInTokenIds: new uint256[](0),
        sig: _hanko(cp, h),
        nonce: acctNonce
      });
    }

    // reserve-to-collateral legs
    if (nR2C > 0) {
      b.reserveToCollateral = new ReserveToCollateral[](nR2C);
      for (uint256 i = 0; i < nR2C; i++) {
        uint256 t = _token(s2 + i);
        (, uint256 cp) = _distinct(a, s3 + i);
        EntityAmount[] memory pairs = new EntityAmount[](1);
        pairs[0] = EntityAmount({ entity: entityOf[cp], amount: bound(s4 + i, 1, _spendable(a, t) + 1) });
        b.reserveToCollateral[i] = ReserveToCollateral({
          tokenId: t,
          receivingEntity: entityOf[a],
          pairs: pairs
        });
      }
    }

    // external withdrawals (decrease reserves + external backing)
    if (nWdr > 0) {
      b.reserveToExternalToken = new ReserveToExternalToken[](nWdr);
      for (uint256 i = 0; i < nWdr; i++) {
        uint256 t = (s5 + i) % 2 + 1; // only ids 1..2 carry external legs
        b.reserveToExternalToken[i] = ReserveToExternalToken({
          receivingEntity: bytes32(uint256(uint160(vm.addr(pk[a])))),
          tokenId: t,
          amount: bound(s6 + i, 1, _spendable(a, t) / nWdr + 1)
        });
      }
    }

    // ── per-batch conservation oracle ──
    uint256[3] memory beforeInternal;
    uint256[3] memory beforeExternal;
    for (uint256 k = 0; k < 3; k++) {
      beforeInternal[k] = _totalInternal(TOKENS[k]);
      beforeExternal[k] = _externalBalance(TOKENS[k]);
    }

    address caller = vm.addr(pk[a]);
    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entityOf[a]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    bytes memory hanko = _hanko(a, h);
    vm.prank(caller); // deposit legs pull transferFrom(msg.sender, ...)
    try dep.processBatch(encoded, hanko, nonce) {
      acceptedBatches++;
      _bump("mixedBatch");
      _recordSubmitOutcome(a, nonce, encoded, hanko);
      for (uint256 k = 0; k < 3; k++) {
        uint256 internalAfter = _totalInternal(TOKENS[k]);
        uint256 backingAfter = _externalBalance(TOKENS[k]);
        if (TOKENS[k] == 3) {
          if (internalAfter != beforeInternal[k]) batchValueViolations++;
          continue;
        }
        // Direction-aware exact match; unsigned subtraction must never wrap.
        if (internalAfter >= beforeInternal[k]) {
          if (
            backingAfter < beforeExternal[k]
              || backingAfter - beforeExternal[k] != internalAfter - beforeInternal[k]
          ) batchValueViolations++;
        } else {
          if (
            backingAfter > beforeExternal[k]
              || beforeExternal[k] - backingAfter != beforeInternal[k] - internalAfter
          ) batchValueViolations++;
        }
      }
    } catch {
      rejectedBatches++;
      if (dep.entityNonces(entityOf[a]) != ghostEntityNonce[a]) nonceViolations++;
      for (uint256 k = 0; k < 3; k++) {
        if (_totalInternal(TOKENS[k]) != beforeInternal[k]) batchValueViolations++;
        if (_externalBalance(TOKENS[k]) != beforeExternal[k]) batchValueViolations++;
      }
    }
  }

  /// @notice Replays the exact calldata triple of the last ACCEPTED batch of an
  ///         actor. Depository.sol:339 requires nonce == entityNonces+1, so the
  ///         replay must always fail, under any interleaving of other calls.
  function replayLast(uint256 actorSeed) external {
    uint256 a = _actor(actorSeed);
    bytes memory encoded = lastEncoded[a];
    if (encoded.length == 0) return; // nothing accepted yet for this actor
    replayAttempts++;
    try dep.processBatch(encoded, lastHanko[a], lastNonce[a]) {
      replayViolations++;
    } catch {}
  }
}
