pragma solidity ^0.8.24;

import "./Token.sol";

contract EntityProvider { 
  struct Entity {

    address tokenAddress;
    string name;

    bytes32 currentBoardHash;
    bytes32 proposedAuthenticatorHash;
  }

  struct Delegate {
    bytes entityId;
    uint16 votingPower;
  }

  struct Board {
    uint16 votingThreshold;
    Delegate[] delegates;
  }

  Entity[] public entities;

  mapping (bytes32 => Entity) public entityMap;
  mapping (uint => uint) public activateAtBlock;


/**
   * @notice Verifies the entity signed _hash, 
     returns uint16: 0 when invalid, or ratio of Yes to Yes+No.
   */
  function isValidSignature(
    bytes32 _hash,
    bytes calldata entityParams,
    bytes calldata encodedEntityBoard,
    bytes calldata encodedSignature,
    bytes32[] calldata entityStack
  ) external view returns (uint16) {

    bytes32 boardHash = keccak256(encodedEntityBoard);

    if (boardHash == bytes32(entityParams)) {
      // uses static board
    } else {
      // uses dynamic board
      require(boardHash == entities[uint(bytes32(entityParams))].currentBoardHash);
    }

    Board memory board = abi.decode(encodedEntityBoard, (Board));
    bytes[] memory signatures = abi.decode(encodedSignature, (bytes[]));


    uint16 voteYes = 0;
    uint16 voteNo = 0;

    for (uint i = 0; i < board.delegates.length; i += 1) {
      Delegate memory delegate = board.delegates[i];

      if (delegate.entityId.length == 20) {
        // EOA address
        address addr = address(uint160(uint256(bytes32(delegate.entityId))));

        /*if (addr == recoverSigner(_hash, signatures[i])) {
          voteYes += delegate.votingPower;
        } else {
          voteNo += delegate.votingPower;
        }*/

      } else {
        // if entityId already exists in stack - recursive, add it to voteYes
        bool recursive = false;
        bytes32 delegateHash = keccak256(delegate.entityId);

        for (uint i2 = 0; i2 < entityStack.length; i2 += 1) {
          if (entityStack[i2] == delegateHash) {
            recursive = true;
            break;
          }
        }

        if (recursive) {
          voteYes += delegate.votingPower;
          continue;
        }


        (address externalEntityProvider, bytes memory externalEntityId) = abi.decode(delegate.entityId, (address, bytes));

        // decode nested signatures
        (bytes memory nestedBoard, bytes memory nestedSignature) = abi.decode(signatures[i], (bytes, bytes) );

        /*

        if (EntityProvider(externalEntityProvider).isValidSignature(
          _hash,
          externalEntityId,
          nestedBoard,
          nestedSignature,
          entityStack
        ) > uint16(0)) {
          voteYes += delegate.votingPower;
        } else {
          voteNo += delegate.votingPower;
        }*/
        // 

      }
      // check if address is in board
    }

    uint16 votingResult = voteYes / (voteYes + voteNo);
    if (votingResult < board.votingThreshold) {
      return 0;
    } else {
      return votingResult;
    }

  }

  function proposeBoard(bytes memory entityId, bytes calldata proposedAuthenticator, bytes[] calldata tokenHolders, bytes[] calldata signatures) public {
    for (uint i = 0; i < tokenHolders.length; i += 1) {

      /* check depositary
      require(
        Token(bytesToAddress(tokenHolders[i])).balanceOf(bytesToAddress(entityId)) > 0,
        "EntityProvider#proposeBoard: token holder does not own any tokens"
      );
      require(
        Token(bytesToAddress(tokenHolders[i])).isValidSignature(
          keccak256(proposedAuthenticator),
          signatures[i]
        ),
        "EntityProvider#proposeBoard: token holder did not sign the proposed board"
      );
      */
    }


    entities[uint(bytes32(entityId))].proposedAuthenticatorHash = keccak256(proposedAuthenticator);


  }

  function activateAuthenticator(bytes calldata entityId) public {
    uint id = uint(bytes32(entityId));
    activateAtBlock[id] = block.number;
    entities[id].currentBoardHash = entities[id].proposedAuthenticatorHash;
  }

  function bytesToAddress(bytes memory bys) private pure returns (address addr) {
      assembly {
        addr := mload(add(bys,20))
      } 
  }
 /**
   * @notice Recover the signer of hash, assuming it's an EOA account
   * @dev Only for EthSign signatures
   * @param _hash       Hash of message that was signed
   * @param _signature  Signature encoded as (bytes32 r, bytes32 s, uint8 v)
   */
   function recoverSigner(
    bytes32 _hash,
    bytes memory _signature
) internal pure returns (address signer) {
    require(_signature.length == 65, "SignatureValidator#recoverSigner: invalid signature length");

    // Extracting v, r, and s from the signature
    uint8 v = uint8(_signature[64]);
    bytes32 r;
    bytes32 s;

    // Assembly code to extract r and s
    assembly {
        // Load the first 32 bytes of the _signature array, skip the first 32 bytes
        r := mload(add(_signature, 32))
        // Load the next 32 bytes of the _signature array
        s := mload(add(_signature, 64))
    }

    // Check the signature recovery id (v) and adjust for Ethereum chain id
    if (v < 27) {
        v += 27;
    }

    require(v == 27 || v == 28, "SignatureValidator#recoverSigner: invalid signature 'v' value");

    // Perform ECDSA signature recovering
    signer = ecrecover(_hash, v, r, s);
    require(signer != address(0), "SignatureValidator#recoverSigner: INVALID_SIGNER");

    return signer;
  }
   /*
  function recoverSigner(
    bytes32 _hash,
    bytes memory _signature
  ) internal pure returns (address signer) {
    require(_signature.length == 65, "SignatureValidator#recoverSigner: invalid signature length");

    // Variables are not scoped in Solidity.
    uint8 v = uint8(_signature[64]);
    //bytes32 r = _signature.readBytes32(0);
    //bytes32 s = _signature.readBytes32(32);

    // Assembly code to extract r and s
    assembly {
        // Load the first 32 bytes of the _signature array, skip the first 32 bytes
        r := mload(add(_signature, 32))
        // Load the next 32 bytes of the _signature array
        s := mload(add(_signature, 64))
    }

    // EIP-2 still allows signature malleability for ecrecover(). Remove this possibility and make the signature
    // unique. Appendix F in the Ethereum Yellow paper (https://ethereum.github.io/yellowpaper/paper.pdf), defines
    // the valid range for s in (281): 0 < s < secp256k1n ÷ 2 + 1, and for v in (282): v ∈ {27, 28}. Most
    // signatures from current libraries generate a unique signature with an s-value in the lower half order.
    //
    // If your library generates malleable signatures, such as s-values in the upper range, calculate a new s-value
    // with 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - s1 and flip v from 27 to 28 or
    // vice versa. If your library also generates signatures with 0/1 for v instead 27/28, add 27 to v to accept
    // these malleable signatures as well.
    //
    // Source OpenZeppelin
    // https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/cryptography/ECDSA.sol

    if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
      revert("SignatureValidator#recoverSigner: invalid signature 's' value");
    }

    if (v != 27 && v != 28) {
      revert("SignatureValidator#recoverSigner: invalid signature 'v' value");
    }

    // Recover ECDSA signer
    signer = ecrecover(_hash, v, r, s);
    
    // Prevent signer from being 0x0
    require(
      signer != address(0x0),
      "SignatureValidator#recoverSigner: INVALID_SIGNER"
    );

    return signer;
  }*/

}