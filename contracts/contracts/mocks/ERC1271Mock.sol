// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Test-only ERC-1271 account for HankoVerifier v2 contract members.
///         OWNER: magic iff the ECDSA signer is `owner`. ALWAYS_VALID: magic for
///         any bytes. REVERT: every call reverts (a member that fails must fail
///         the proof softly, never revert the caller).
contract ERC1271Mock {
  enum Mode { OWNER, ALWAYS_VALID, REVERT }

  bytes4 private constant MAGIC = 0x1626ba7e;

  address public owner;
  Mode public mode;

  constructor(address owner_) {
    owner = owner_;
  }

  function setMode(Mode mode_) external {
    mode = mode_;
  }

  function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
    if (mode == Mode.REVERT) revert("ERC1271Mock: revert");
    if (mode == Mode.ALWAYS_VALID) return MAGIC;
    (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
    if (err == ECDSA.RecoverError.NoError && recovered == owner) return MAGIC;
    return 0xffffffff;
  }
}
