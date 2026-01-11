import { writable, get } from 'svelte/store';
import { EVM_NETWORKS, type EVMNetwork } from '$lib/config/evmNetworks';

export type NetworkStatus = 'connected' | 'connecting' | 'error';

export const selectedNetwork = writable<EVMNetwork>(EVM_NETWORKS[0]!);
export const networkStatus = writable<NetworkStatus>('connecting');

async function checkNetwork(network: EVMNetwork) {
  try {
    networkStatus.set('connecting');
    const { JsonRpcProvider } = await import('ethers');
    const provider = new JsonRpcProvider(network.rpcUrl);
    await provider.getBlockNumber();
    networkStatus.set('connected');
  } catch {
    networkStatus.set('error');
  }
}

export async function setNetwork(network: EVMNetwork) {
  selectedNetwork.set(network);
  await checkNetwork(network);
}

export async function refreshNetworkStatus() {
  const network = get(selectedNetwork);
  await checkNetwork(network);
}
