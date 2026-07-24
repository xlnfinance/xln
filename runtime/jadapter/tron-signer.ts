import { ethers } from 'ethers';
import type { TronWeb as TronWebInstance } from 'tronweb';
import { safeStringify } from '../protocol/serialization';

type TronWebConstructor = typeof import('tronweb')['TronWeb'];
type TronTransferTransaction = Awaited<
  ReturnType<TronWebInstance['transactionBuilder']['sendTrx']>
>;
type TronTriggerResult = Awaited<
  ReturnType<TronWebInstance['transactionBuilder']['triggerSmartContract']>
>;
type TronContractTransaction = NonNullable<TronTriggerResult['transaction']>;

const DEFAULT_TRON_FEE_LIMIT = 15_000_000_000;
const DEFAULT_TRON_POLL_MS = 3_000;
const DEFAULT_TRON_WAIT_MS = 300_000;

const resolveFullHost = (rpcUrl: string, explicit?: string): string =>
  String(explicit || rpcUrl).replace(/\/jsonrpc\/?$/i, '').replace(/\/$/, '');

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const transactionError = (prefix: string, value: unknown): Error =>
  new Error(`${prefix}:${typeof value === 'string' ? value : safeStringify(value)}`);

export class TronSigner extends ethers.AbstractSigner<ethers.JsonRpcProvider> {
  readonly #privateKey: string;
  readonly #wallet: ethers.Wallet;
  readonly #tronWeb: TronWebInstance;
  readonly #TronWeb: TronWebConstructor;
  readonly #maxFeeLimit: number;
  readonly #owner: string;
  readonly #rpcUrl: string;
  readonly #fullHost: string | undefined;
  readonly #apiKey: string | undefined;
  #energyFee: Promise<number> | undefined;

  constructor(params: {
    provider: ethers.JsonRpcProvider;
    privateKey: string;
    rpcUrl: string;
    fullHost?: string | undefined;
    apiKey?: string | undefined;
  }, TronWeb: TronWebConstructor) {
    super(params.provider);
    this.#TronWeb = TronWeb;
    this.#privateKey = params.privateKey.replace(/^0x/, '');
    this.#rpcUrl = params.rpcUrl;
    this.#fullHost = params.fullHost;
    this.#apiKey = params.apiKey;
    this.#wallet = new ethers.Wallet(`0x${this.#privateKey}`);
    this.#maxFeeLimit = Number(process.env['TRON_FEE_LIMIT'] || DEFAULT_TRON_FEE_LIMIT);
    if (!Number.isSafeInteger(this.#maxFeeLimit) || this.#maxFeeLimit <= 0) {
      throw new Error(`TRON_FEE_LIMIT_INVALID:${String(this.#maxFeeLimit)}`);
    }
    this.#tronWeb = new this.#TronWeb({
      fullHost: resolveFullHost(params.rpcUrl, params.fullHost),
      privateKey: this.#privateKey,
      ...(params.apiKey ? { headers: { 'TRON-PRO-API-KEY': params.apiKey } } : {}),
    });
    const owner = this.#tronWeb.defaultAddress.base58;
    if (!owner) throw new Error('TRON_SIGNER_ADDRESS_MISSING');
    this.#owner = owner;
    const tronEvmAddress = `0x${this.#tronWeb.address.toHex(this.#owner).slice(2)}`.toLowerCase();
    if (tronEvmAddress !== this.#wallet.address.toLowerCase()) {
      throw new Error(`TRON_SIGNER_ADDRESS_MISMATCH:ethers=${this.#wallet.address}:tron=${tronEvmAddress}`);
    }
  }

  override getAddress(): Promise<string> {
    return Promise.resolve(this.#wallet.address);
  }

  override connect(provider: null | ethers.Provider): TronSigner {
    if (!(provider instanceof ethers.JsonRpcProvider)) throw new Error('TRON_JSON_RPC_PROVIDER_REQUIRED');
    return new TronSigner({
      provider,
      privateKey: this.#privateKey,
      rpcUrl: this.#rpcUrl,
      fullHost: this.#fullHost,
      apiKey: this.#apiKey,
    }, this.#TronWeb);
  }

  forPrivateKey(privateKey: string): TronSigner {
    return new TronSigner({
      provider: this.provider,
      privateKey,
      rpcUrl: this.#rpcUrl,
      fullHost: this.#fullHost,
      apiKey: this.#apiKey,
    }, this.#TronWeb);
  }

  override async signTransaction(): Promise<string> {
    throw new Error('TRON_PROTOBUF_TRANSACTION_REQUIRED');
  }

  override signMessage(message: string | Uint8Array): Promise<string> {
    return this.#wallet.signMessage(message);
  }

  override signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<ethers.TypedDataField>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.#wallet.signTypedData(domain, types, value);
  }

  async #resolveCall(tx: ethers.TransactionRequest): Promise<{
    to: string;
    data: string;
    callValue: number;
  }> {
    if (tx.to == null) throw new Error('TRON_CONTRACT_CREATION_USES_DEPLOY_MATRIX');
    const to = await ethers.resolveAddress(tx.to, this.provider);
    const data = String(await tx.data || '0x');
    if (!ethers.isHexString(data)) throw new Error('TRON_CALLDATA_INVALID');
    const value = BigInt(await tx.value || 0n);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`TRON_CALL_VALUE_UNSAFE:${value}`);
    const tronHex = `41${to.slice(2)}`;
    return {
      to: this.#tronWeb.address.fromHex(tronHex),
      data,
      callValue: Number(value),
    };
  }

  override async call(tx: ethers.TransactionRequest): Promise<string> {
    const call = await this.#resolveCall(tx);
    const result = await this.#tronWeb.transactionBuilder.triggerConstantContract(
      call.to,
      '',
      { input: call.data.slice(2), callValue: call.callValue },
      [],
      this.#owner,
    );
    if (!result?.result?.result || !Array.isArray(result.constant_result)) {
      throw transactionError('TRON_CONSTANT_CALL_FAILED', result);
    }
    return `0x${result.constant_result[0] || ''}`;
  }

  override async estimateGas(tx: ethers.TransactionRequest): Promise<bigint> {
    const call = await this.#resolveCall(tx);
    const result = await this.#tronWeb.transactionBuilder.estimateEnergy(
      call.to,
      '',
      { input: call.data.slice(2), callValue: call.callValue },
      [],
      this.#owner,
    );
    const energy = Number(result?.energy_required);
    if (!result?.result?.result || !Number.isSafeInteger(energy) || energy <= 0) {
      throw transactionError('TRON_ESTIMATE_ENERGY_FAILED', result);
    }
    return BigInt(energy);
  }

  async #readEnergyFee(): Promise<number> {
    this.#energyFee ??= this.#tronWeb.trx.getChainParameters().then((parameters) => {
      const fee = Number(parameters.find((parameter) => parameter.key === 'getEnergyFee')?.value);
      if (!Number.isSafeInteger(fee) || fee <= 0) throw new Error(`TRON_ENERGY_FEE_INVALID:${String(fee)}`);
      return fee;
    });
    return this.#energyFee;
  }

  override async sendTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
    const call = await this.#resolveCall(tx);
    let unsigned: TronTransferTransaction | TronContractTransaction;
    if (call.data === '0x') {
      // Native TRX transfers consume bandwidth, not smart-contract Energy.
      // Estimating Energy here misclassifies a fresh recipient as a missing
      // contract and prevents the transfer that would activate the account.
      unsigned = await this.#tronWeb.transactionBuilder.sendTrx(call.to, call.callValue, this.#owner);
    } else {
      const requestedEnergy = BigInt(await tx.gasLimit || await this.estimateGas(tx));
      const energyFee = await this.#readEnergyFee();
      const estimatedFeeLimit = requestedEnergy * BigInt(energyFee);
      if (estimatedFeeLimit > BigInt(this.#maxFeeLimit)) {
        throw new Error(
          `TRON_TRANSACTION_FEE_LIMIT_EXCEEDED:required=${estimatedFeeLimit}:maximum=${this.#maxFeeLimit}`,
        );
      }
      const feeLimit = Number(estimatedFeeLimit);
      if (!Number.isSafeInteger(feeLimit) || feeLimit <= 0) {
        throw new Error(`TRON_TRANSACTION_FEE_LIMIT_INVALID:${String(feeLimit)}`);
      }
      unsigned = await this.#tronWeb.transactionBuilder.triggerSmartContract(
          call.to,
          '',
          { input: call.data.slice(2), callValue: call.callValue, feeLimit },
          [],
          this.#owner,
        ).then((triggered) => {
          if (!triggered?.result?.result || !triggered.transaction) {
            throw transactionError('TRON_TRIGGER_FAILED', triggered);
          }
          return triggered.transaction;
        });
    }
    const signed = await this.#tronWeb.trx.sign(unsigned, this.#privateKey);
    if (!signed?.signature?.length) throw new Error('TRON_TRANSACTION_SIGNATURE_MISSING');
    const broadcast = await this.#tronWeb.trx.sendRawTransaction(signed);
    if (!broadcast?.result) throw transactionError('TRON_BROADCAST_FAILED', broadcast);
    const hash = `0x${String(signed.txID).replace(/^0x/, '')}`;
    const provider = this.provider;
    const response = {
      hash,
      wait: async (_confirms = 1, timeout = DEFAULT_TRON_WAIT_MS) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const receipt = await provider.getTransactionReceipt(hash);
          if (receipt) {
            if (receipt.status !== 1) throw new Error(`TRON_TRANSACTION_REVERTED:${hash}`);
            return receipt;
          }
          await wait(DEFAULT_TRON_POLL_MS);
        }
        throw new Error(`TRON_TRANSACTION_RECEIPT_TIMEOUT:${hash}:${timeout}`);
      },
    };
    return response as unknown as ethers.TransactionResponse;
  }
}

export const createTronSigner = async (
  params: ConstructorParameters<typeof TronSigner>[0],
): Promise<TronSigner> => {
  // TronWeb publishes distinct import/require entrypoints. Its generated
  // protobuf runtime is CommonJS, so server-side TRON transport must load the
  // package's declared require entrypoint. This module is never entered by the
  // BrowserVM adapter.
  const { createRequire } = await import('node:module');
  const { TronWeb } = createRequire(import.meta.url)('tronweb') as typeof import('tronweb');
  return new TronSigner(params, TronWeb);
};
