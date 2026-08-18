import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { decodeDisputeStarterInitialSecrets } from '../../../entity/tx/j-events-htlc';

describe('dynamic dispute transformer arguments', () => {
  test('decodes canonical secret evidence and ignores malformed adversarial bytes', () => {
    const secret = `0x${'42'.repeat(32)}`;
    const transformerArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets)'],
      [{ fillRatios: [], secrets: [secret] }],
    );
    const starterArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes[]'],
      [[transformerArgs]],
    );

    expect(decodeDisputeStarterInitialSecrets(starterArgs)).toEqual([secret]);
    expect(decodeDisputeStarterInitialSecrets('0x1234')).toEqual([]);
    expect(decodeDisputeStarterInitialSecrets('0x')).toEqual([]);
  });
});
