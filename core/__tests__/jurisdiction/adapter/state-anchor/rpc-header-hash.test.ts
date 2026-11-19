import { expect, test } from 'bun:test';
import { ethereumHeaderHash } from '../../../../jurisdiction/adapter/rpc/state-anchor/rpc-header-hash';

// Captured Ethereum Sepolia block 12149817. The independent RPC block hash
// binds every header field, including Glamsterdam EIP-7928 and EIP-7843.
const header = {
  hash: '0xf541fe2ed85d9c696d4e3b3e9a2abfc2d32d665a076666e50600ca3ec80f75a4',
  parentHash: '0x7d45c8cb7fb2e95893881fc123301704e471275e15c174127a485631cc4a9a32',
  sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
  miner: '0x8f614cdb61e37b6f18d9705942c93fa86b04d711',
  stateRoot: '0x6e50e341b575ac038c1707183ee12fe75ceaa599d03b1e8718855a4712dac46a',
  transactionsRoot: '0x1e8b2ca8f1f7067842e8bdb26f9484482dc469a3fc82da3c30121bbdb6368486',
  receiptsRoot: '0x0a82cedb80aefcd14c8f0ff66fd45ced061f546aa9154795ef3f3ccf565807c3',
  logsBloom:
    '0x9ee5938c48829090554c1b788ce99a59edd9aa894bd2d0cbd2891f6777b3fe6a513a68080fa56a3f07301dbb61f56028639a911160bf330338135b80fc2d6cbb9911fc530bcd635d26e0008fe538ae353a3caa6800669b7b0ba905b5059413a1af63211d72b06161a02a93f2842fbd8b7e9b7815f02557909aa0d99d815f72f298808840c97e5960f372d012e234557c0f4539ec60263ae94cbfd8cba452b52aa698eb03b014e0eada0ca736644bcc8403831f81680452d8e0229e8e16c874a560c9b75ea4cf52b00e4d7025f7f361390f75080a068f3a18423dc5ab6cf476ea2699a1410682199b5126db026f11cc8803a79b7623b2659ee1830bee1a61ce4d',
  difficulty: '0x0',
  number: '0xb96439',
  gasLimit: '0xbebc141',
  gasUsed: '0x680b824',
  timestamp: '0x6afb6d98',
  extraData: '0x6275696c6465722e6e666c6169672e65746820303733373662643964303064',
  mixHash: '0x140faea3140cbc8e959a3ce1fbde9e9d1726bac4d7a54c1cbffb4a4e40b664e2',
  nonce: '0x0000000000000000',
  baseFeePerGas: '0xf',
  withdrawalsRoot: '0xdebd279f0c81a981ac97d4efbc11b2efb738837c1abf78387ef1c1c75253c2a5',
  blobGasUsed: '0x2a0000',
  excessBlobGas: '0x0',
  parentBeaconBlockRoot: '0x9a6cafff0b465f9fe7ed538c9089139e54b7156022776b56e0adb66deaad8e77',
  requestsHash: '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  blockAccessListHash: '0x4bdec5a4a28bc19ae6e2851ade7d39cf8e69c9792be6cb6c3289f1bfa8c77aad',
  slotNumber: '0xb0e95a',
};

test('the captured public Sepolia header authenticates its state root', () => {
  expect(ethereumHeaderHash(header)).toBe(header.hash);
});

test('changing either Glamsterdam commitment cannot retain the block authority', () => {
  expect(ethereumHeaderHash({ ...header, blockAccessListHash: `0x${'11'.repeat(32)}` })).not.toBe(header.hash);
  expect(ethereumHeaderHash({ ...header, slotNumber: '0x1' })).not.toBe(header.hash);
  expect(ethereumHeaderHash({ ...header, stateRoot: `0x${'22'.repeat(32)}` })).not.toBe(header.hash);
});

test('a later fork field requires the complete preceding header prefix', () => {
  expect(() => ethereumHeaderHash({ ...header, blockAccessListHash: null })).toThrow('FORK_FIELDS_NOT_CONTIGUOUS');
  expect(() => ethereumHeaderHash({ ...header, blockAccessListHash: '0x12' })).toThrow('FIELD_INVALID');
  expect(() => ethereumHeaderHash({ ...header, slotNumber: '0x00' })).toThrow('FIELD_INVALID');
});
