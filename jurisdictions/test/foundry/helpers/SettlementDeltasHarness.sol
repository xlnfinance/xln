// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "../../../contracts/Account.sol";
import "../../../contracts/HashLadder.sol";
import "../../../contracts/HashLadderRegistry.sol";
import "../../../contracts/Types.sol";
import "../../../contracts/mocks/TransformerLivenessHarness.sol";

/// @notice Signature-free entry into the REAL Account.prepareSettlementDeltas
///         bytecode (the function that owns the Account.sol:996 allowance gate
///         and the _clampTransformerValue band), plus a fresh ordered-pair
///         storage mirror for HashLadderRegistry.
///
/// Account.prepareSettlementDeltas performs no Hanko/ECDSA verification —
/// signatures are checked by its callers — so a contract that binds its own
/// storage can execute the exact production delta pipeline with symbolic
/// inputs. This is what makes the allowance/clamp lemmas reachable to Halmos
/// without modeling secp256k1.
contract SettlementDeltasHarness {
  mapping(bytes => mapping(uint256 => AccountCollateral)) public collaterals;
  mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => mapping(bool => uint256))))
    public ladderRecords;
  mapping(bytes => AccountInfo) public accounts;

  TransformerLivenessHarness public immutable transformer;

  constructor(TransformerLivenessHarness _transformer) {
    transformer = _transformer;
  }

  /// @dev One ProofBody-shaped input; leftArguments/rightArguments stay empty
  ///      (malformed wrappers decode to empty evidence by design).
  ///      Returns (delta0, negativeDeltaBitmap, reverted, gasArtifact).
  ///      `gasArtifact` is true when the revert is TransformerGasBudgetUnavailable:
  ///      halmos 0.3.3 models GAS symbolically, so that branch is feasible in
  ///      the model even though a real EVM run of this harness never takes it
  ///      (forge fuzzes the same entrypoint with 300M gas: zero reverts).
  ///      Lemmas tolerate exactly that selector and nothing else.
  function run(
    int256 ondelta,
    int256 offdelta,
    uint256 tokenId,
    TransformerLivenessHarness.Mode mode,
    int256 value,
    bool withAllowance,
    uint256 rightAllowance,
    uint256 leftAllowance
  )
    external
    returns (int256 delta0, uint256 negativeDeltaBitmap, bool reverted, bool gasArtifact)
  {
    ProofBody memory pb;
    pb.watchSeed = bytes32("halmos");
    pb.leftResponseSeconds = 0;
    pb.rightResponseSeconds = 0;
    pb.offdeltas = new int256[](1);
    pb.offdeltas[0] = offdelta;
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = tokenId;
    pb.transformers = new TransformerClause[](1);
    Allowance[] memory allowances = new Allowance[](withAllowance ? 1 : 0);
    if (withAllowance) {
      allowances[0] =
        Allowance({ deltaIndex: 0, rightAllowance: rightAllowance, leftAllowance: leftAllowance });
    }
    pb.transformers[0] = TransformerClause({
      transformerAddress: address(transformer),
      encodedBatch: transformer.encode(mode, 0, value, tokenId),
      allowances: allowances
    });

    bytes memory acctKey = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)));
    collaterals[acctKey][tokenId].ondelta = ondelta;

    try Account.prepareSettlementDeltas(
      collaterals,
      acctKey,
      pb,
      "",
      "",
      0,
      0,
      bytes32(uint256(1)),
      bytes32(uint256(2)),
      address(transformer),
      0,
      0,
      0,
      0
    ) returns (int[] memory deltas, uint256 bitmap) {
      delta0 = deltas[0];
      negativeDeltaBitmap = bitmap;
      reverted = false;
      gasArtifact = false;
    } catch (bytes memory lowLevelData) {
      reverted = true;
      gasArtifact = lowLevelData.length == 4
        && bytes4(lowLevelData) == IDepositoryDelegateErrorAbi.TransformerGasBudgetUnavailable.selector;
    }
  }

  // ── ordered-pair storage mirror for HashLadderRegistry (full-fill only so
  //    the witness check is one keccak application on derived inputs) ──

  function _ladder(bytes32 writer, bytes32 counterparty, bytes32 fullSecret)
    internal pure returns (bytes32)
  {
    return keccak256(
      abi.encodePacked(
        HashLadder.hashFullSecret(fullSecret),
        keccak256(abi.encode(writer, counterparty, "partial"))
      )
    );
  }

  /// @dev Registers a full-fill TARGET reveal (Target has no dispute-window
  ///      dependency) and returns the post-state of the written slot.
  function registerTarget(bytes32 writer, bytes32 counterparty, bytes32 fullSecret)
    external returns (uint16 ratio, uint256 revealedAt)
  {
    HashLadderRegistration memory reg;
    reg.counterpartyEntity = counterparty;
    reg.targetRole = true;
    reg.fullHash = HashLadder.hashFullSecret(fullSecret);
    reg.partialRoot = keccak256(abi.encode(writer, counterparty, "partial"));
    reg.witness.fillRatio = type(uint16).max; // FULL_FILL_RATIO fast path
    reg.witness.fullSecret = fullSecret;
    HashLadderRegistry.registerReveal(ladderRecords, accounts, writer, reg);
    return HashLadderRegistry.getReveal(
      ladderRecords, writer, counterparty, _ladder(writer, counterparty, fullSecret), true
    );
  }

  /// @dev Reads the REVERSED slot (counterparty as writer) for the same ladder.
  function readReverse(bytes32 writer, bytes32 counterparty, bytes32 fullSecret)
    external view returns (uint16 ratio, uint256 revealedAt)
  {
    return HashLadderRegistry.getReveal(
      ladderRecords, counterparty, writer, _ladder(writer, counterparty, fullSecret), true
    );
  }
}
