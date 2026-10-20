import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { TronWeb } from 'tronweb';

const require = createRequire(import.meta.url);
type Prepared = Awaited<ReturnType<TronWeb['transactionBuilder']['createSmartContract']>>;
type Header = Pick<Prepared['raw_data'], 'ref_block_bytes' | 'ref_block_hash' | 'timestamp' | 'expiration'>;
const { prepareTronContract } = require('../../../../jurisdictions/scripts/deploy-chain-matrix.cjs') as {
  prepareTronContract(
    client: TronWeb,
    name: string,
    parameters: string[],
    libraries: Record<string, { evm: string }>,
    header: Header,
  ): Promise<Prepared>;
};
const owner = 'TSbKEPV1778MRVRuJdRfgW79H6ABB2KVbC';
const header: Header = {
  ref_block_bytes: '0001',
  ref_block_hash: '1122334455667788',
  timestamp: 1_792_471_000_000,
  expiration: 1_792_471_060_000,
};
const publicClient = () => {
  // An unreachable endpoint proves that an explicit header needs no RPC or key.
  const client = new TronWeb({ fullHost: 'http://127.0.0.1:1' });
  client.setAddress(owner);
  return client;
};

describe('canonical unsigned TRON deployment', () => {
  test('builds reproducible deployment bytes with only the public owner and explicit TAPOS', async () => {
    const client = publicClient();
    expect(client.defaultPrivateKey).toBe(false);
    const first = await prepareTronContract(client, 'Account', [], {}, header);
    const second = await prepareTronContract(client, 'Account', [], {}, header);
    expect(first).toEqual(second);
    expect(first.signature).toBeUndefined();
    expect(first.raw_data.contract[0].parameter.value.owner_address).toBe(TronWeb.address.toHex(owner));
    expect(first.raw_data.contract[0].type).toBe('CreateSmartContract');
    expect(first.raw_data.expiration).toBe(header.expiration);
    expect(first.txID).toMatch(/^[0-9a-f]{64}$/);
    expect(first.contract_address).toMatch(/^41[0-9a-f]{40}$/);
    const changed = await prepareTronContract(
      client,
      'Account',
      [],
      {},
      { ...header, expiration: header.expiration + 1 },
    );
    expect(changed.txID).not.toBe(first.txID);
    expect(changed.contract_address).not.toBe(first.contract_address);
  });

  test('links the predicted library and encodes the Foundation owner without signing', async () => {
    const client = publicClient();
    const library = await prepareTronContract(client, 'HankoVerifier', [], {}, header);
    const evm = `0x${library.contract_address.slice(2)}`;
    const transaction = await prepareTronContract(
      client,
      'EntityProvider',
      [owner],
      { HankoVerifier: { evm } },
      header,
    );
    const code = transaction.raw_data.contract[0].parameter.value.new_contract.bytecode;
    expect(code).toMatch(/^[0-9a-f]+$/i);
    expect(code.toLowerCase()).toContain(evm.slice(2));
    expect(code.endsWith(TronWeb.address.toHex(owner).slice(2).padStart(64, '0'))).toBe(true);
    expect(transaction.signature).toBeUndefined();
  });

  test('rejects missing links and constructor arguments before any deployment exists', async () => {
    const client = publicClient();
    await expect(prepareTronContract(client, 'EntityProvider', [owner], {}, header)).rejects.toThrow(
      'unresolved library link placeholders',
    );
    const library = await prepareTronContract(client, 'HankoVerifier', [], {}, header);
    await expect(
      prepareTronContract(
        client,
        'EntityProvider',
        [],
        { HankoVerifier: { evm: `0x${library.contract_address.slice(2)}` } },
        header,
      ),
    ).rejects.toThrow('constructor needs 1 but 0 provided');
  });
});
