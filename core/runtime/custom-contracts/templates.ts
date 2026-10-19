import { safeStringify } from '../../protocol/serialization';
import type { ClauseField } from './types';

const schemaFunction = (name: string, fields: readonly ClauseField[]): string =>
  `function ${name}() external pure returns (string memory) { return '${safeStringify(fields)}'; }`;
const amountFields: ClauseField[] = [
  { name: 'tokenId', type: 'uint256', label: 'Token ID' },
  { name: 'amount', type: 'uint256', label: 'Amount in smallest token units' },
  { name: 'payerIsLeft', type: 'bool', label: 'Left Entity pays' },
];

const buildTemplate = (
  name: string,
  params: ClauseField[],
  left: ClauseField[],
  right: ClauseField[],
  body: string,
): string => `// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import "WideMath.sol";
contract ${name} {
  ${schemaFunction('paramsSchema', params)}
  ${schemaFunction('leftArgsSchema', left)}
  ${schemaFunction('rightArgsSchema', right)}
  function applyBatch(
    Int768[] calldata deltas, uint256[] calldata tokenIds, bytes calldata encodedBatch,
    bytes calldata leftArguments, bytes calldata rightArguments,
    uint256 leftArgumentsTimestamp, uint256 rightArgumentsTimestamp,
    bytes32 leftEntity, bytes32 rightEntity, uint256 disputeStartTimestamp,
    uint256 disputeTimeout, uint32 leftResponseSeconds, uint32 rightResponseSeconds
  ) external view returns (Int768[] memory result) {
    result = deltas;
    ${body}
  }
  function move(Int768[] memory result, uint256[] calldata tokenIds, uint256 tokenId, uint256 amount, bool payerIsLeft) internal pure {
    for (uint256 i; i < tokenIds.length; i++) {
      if (tokenIds[i] == tokenId) {
        result[i] = WideMath.add(result[i], WideMath.expand(SignedAmount(payerIsLeft, amount)));
        return;
      }
    }
    revert("TOKEN_NOT_IN_ACCOUNT");
  }
}`;

export const CUSTOM_CONTRACT_TEMPLATES = [
  {
    id: 'conditional-payment', name: 'Conditional payment', contractName: 'ConditionalPayment',
    description: 'The beneficiary chooses whether to execute the signed payment.',
    source: buildTemplate('ConditionalPayment', amountFields,
      [{ name: 'execute', type: 'bool', label: 'Execute payment' }],
      [{ name: 'execute', type: 'bool', label: 'Execute payment' }], `
      (uint256 tokenId, uint256 amount, bool payerIsLeft) = abi.decode(encodedBatch, (uint256,uint256,bool));
      bytes calldata beneficiaryArgs = payerIsLeft ? rightArguments : leftArguments;
      if (beneficiaryArgs.length == 0 || !abi.decode(beneficiaryArgs, (bool))) return result;
      move(result, tokenIds, tokenId, amount, payerIsLeft);`),
  },
  {
    id: 'secret-payment', name: 'Secret payment', contractName: 'SecretPayment',
    description: 'The beneficiary supplies a secret matching the signed hash before expiry.',
    source: buildTemplate('SecretPayment', [...amountFields,
      { name: 'hash', type: 'bytes32', label: 'keccak256(abi.encode(secret))' },
      { name: 'expiry', type: 'uint256', label: 'Expiry in Unix seconds' }],
      [{ name: 'secret', type: 'bytes32', label: 'Secret' }],
      [{ name: 'secret', type: 'bytes32', label: 'Secret' }], `
      (uint256 tokenId, uint256 amount, bool payerIsLeft, bytes32 hash, uint256 expiry) = abi.decode(encodedBatch, (uint256,uint256,bool,bytes32,uint256));
      bytes calldata beneficiaryArgs = payerIsLeft ? rightArguments : leftArguments;
      uint256 suppliedAt = payerIsLeft ? rightArgumentsTimestamp : leftArgumentsTimestamp;
      if (beneficiaryArgs.length == 0 || suppliedAt > expiry) return result;
      bytes32 secret = abi.decode(beneficiaryArgs, (bytes32));
      if (keccak256(abi.encode(secret)) != hash) return result;
      move(result, tokenIds, tokenId, amount, payerIsLeft);`),
  },
] as const;
