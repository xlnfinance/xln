import { expect, test } from 'bun:test';
import { ethers } from 'ethers';
import { assertTronRpcHeaderBinding, parseNativeTronHeader } from '../../../jurisdiction/adapter/operations/tron-authority';
import fixture from '../../../../rscore/fixtures/tron-signed-call-v1.json';

test('native TAPOS source binds its actual block identity and clock to the configured RPC', () => {
  const header = parseNativeTronHeader(fixture.head);
  const rpc = { hash: `0x${fixture.head.blockID}`, number: ethers.toQuantity(42),
    timestamp: ethers.toQuantity(fixture.head.block_header.raw_data.timestamp / 1000) };
  expect(() => assertTronRpcHeaderBinding(header, rpc)).not.toThrow();
  expect(() => assertTronRpcHeaderBinding(header, { ...rpc, hash: ethers.ZeroHash })).toThrow('HEADER_MISMATCH');
  expect(() => assertTronRpcHeaderBinding(header, { ...rpc, number: '0x2b' })).toThrow('HEADER_MISMATCH');
  expect(() => assertTronRpcHeaderBinding(header, { ...rpc, timestamp: '0x01' })).toThrow('HEADER_MISMATCH');
  expect(() => parseNativeTronHeader({ ...fixture.head, blockID: 'ff'.repeat(32) })).toThrow('HEADER_INVALID');
  expect(() => parseNativeTronHeader({ ...fixture.head, block_header: { raw_data: {
    ...fixture.head.block_header.raw_data, timestamp: -1,
  } } })).toThrow('HEADER_INVALID');
});
