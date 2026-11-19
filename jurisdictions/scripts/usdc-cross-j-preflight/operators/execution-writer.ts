import { JsonRpcProvider } from 'ethers';
import { readCliOption } from '../../../../core/config/cli';
import { authorityDigest, readAuthority, requireCurrentAuthority } from '../execution/authority';
import type { ExecutionProviders } from '../execution/providers';
import { readSourceC2RAuthority, requireSourceC2RAuthority } from '../execution/source-c2r/authority';
import { submitSourceC2R } from '../execution/source-c2r/submission';
import { submitAuthorizedWire, verifyConsumedPayerSlots, verifyExecutionChain } from '../execution/submission';
import { networks } from '../identities';
import { runtimeRpc } from '../provider';

type ExecutionWriter = Readonly<{
  digest: () => string;
  submit: (raw: string) => Promise<string>;
  close: () => void;
}>;

export const openExecutionWriters = async (
  args: string[],
  apiBase: string,
  catalogPath: string,
  readers: ReadonlyMap<string, JsonRpcProvider>,
): Promise<ReadonlyMap<number, ExecutionWriter>> => {
  const journeyPath = readCliOption(args, '--authority-file', '');
  const c2rPath = readCliOption(args, '--source-c2r-authority-file', '');
  if (journeyPath && c2rPath) throw new Error('USDC_EXECUTION_GATEWAY_AUTHORITIES_CONFLICT');
  const writers = new Map<number, ExecutionWriter>();
  if (!journeyPath && !c2rPath) return writers;
  const authority = journeyPath ? readAuthority(journeyPath) : readSourceC2RAuthority(c2rPath);
  if (!catalogPath || authority.apiBase !== apiBase) throw new Error('USDC_EXECUTION_GATEWAY_BINDING_INVALID');
  const connect = (network: (typeof networks)[number]): ExecutionProviders => ({
    current: new JsonRpcProvider(runtimeRpc(network), network.chainId, { cacheTimeout: -1 }),
    historical: readers.get('/history' + network.path)!,
  });
  const digest = authorityDigest(authority);
  if ('runIds' in authority) {
    requireCurrentAuthority(authority, catalogPath);
    for (const network of networks) {
      const chain = authority.chains.find(value => value.chainId === network.chainId)!;
      const connection = connect(network);
      await verifyExecutionChain(connection, chain);
      await verifyConsumedPayerSlots(authority, connection, chain);
      writers.set(chain.chainId, {
        digest: () => {
          requireCurrentAuthority(authority, catalogPath);
          return digest;
        },
        submit: raw => submitAuthorizedWire(authority, catalogPath, connection, chain, raw),
        close: () => connection.current.destroy(),
      });
    }
    return writers;
  }
  requireSourceC2RAuthority(authority, catalogPath);
  const connection = connect(networks.find(network => network.chainId === authority.chain.chainId)!);
  await verifyExecutionChain(connection, { ...authority.chain, payers: [authority.payer] });
  // One slot per gateway. RPC batches and simultaneous callers cannot both
  // pass the pending-nonce check before the first broadcast reaches upstream.
  let previous: Promise<void> = Promise.resolve();
  writers.set(authority.chain.chainId, {
    digest: () => {
      requireSourceC2RAuthority(authority, catalogPath);
      return digest;
    },
    submit: raw => {
      const submission = previous.then(() => submitSourceC2R(authority, catalogPath, connection, raw));
      previous = submission.then(
        () => undefined,
        () => undefined,
      );
      return submission;
    },
    close: () => connection.current.destroy(),
  });
  return writers;
};
