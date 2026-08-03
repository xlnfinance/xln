import { HDNodeWallet, Mnemonic, getIndexedAccountPath } from 'ethers';

/** Same BIP44 account-path derivation the canonical wallet uses (vault-recovery.ts). */
export function deriveAddress(seed: string, index: number): string {
	const mnemonic = Mnemonic.fromPhrase(seed);
	return HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(index)).address.toLowerCase();
}

export function derivePrivateKeyBytes(seed: string, index: number): Uint8Array {
	const mnemonic = Mnemonic.fromPhrase(seed);
	const privateKey = HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(index)).privateKey;
	const hex = privateKey.slice(2);
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

export function isValidMnemonic(phrase: string): boolean {
	try {
		Mnemonic.fromPhrase(phrase.trim());
		return true;
	} catch {
		return false;
	}
}

export function runtimeIdForSeed(seed: string): string {
	return deriveAddress(seed, 0);
}
