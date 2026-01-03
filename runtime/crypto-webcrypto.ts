/**
 * Web Crypto API Provider (RSA-OAEP)
 *
 * Native browser/Bun cryptography - zero dependencies
 * Phase 2: Production-ready for testnet
 * Phase 3+: Swap to Kyber for post-quantum resistance
 */

import type { CryptoProvider, CryptoKeyPair } from './crypto-provider';

export class WebCryptoProvider implements CryptoProvider {
  private readonly algorithm = {
    name: 'RSA-OAEP',
    modulusLength: 4096, // Larger key for nested envelope encryption (~446 byte max payload)
    publicExponent: new Uint8Array([1, 0, 1]), // 65537
    hash: 'SHA-256'
  };

  async generateKeyPair(): Promise<CryptoKeyPair> {
    // Generate RSA-OAEP key pair
    const keyPair = await crypto.subtle.generateKey(
      this.algorithm,
      true, // extractable
      ['encrypt', 'decrypt']
    );

    // Export to base64
    const publicKeyBuffer = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const privateKeyBuffer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

    return {
      publicKey: this.bufferToBase64(publicKeyBuffer),
      privateKey: this.bufferToBase64(privateKeyBuffer)
    };
  }

  async encrypt(data: string, recipientPubKey: string | undefined): Promise<string> {
    if (!recipientPubKey) {
      throw new Error('Recipient public key required for encryption');
    }

    // Import recipient's public key
    const publicKeyBuffer = this.base64ToBuffer(recipientPubKey);
    const publicKey = await crypto.subtle.importKey(
      'spki',
      publicKeyBuffer,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );

    // Encrypt data
    const dataBuffer = new TextEncoder().encode(data);
    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      publicKey,
      dataBuffer
    );

    return this.bufferToBase64(encryptedBuffer);
  }

  async decrypt(encryptedData: string, privateKey: string): Promise<string> {
    // Import private key
    const privateKeyBuffer = this.base64ToBuffer(privateKey);
    const key = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBuffer,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt']
    );

    // Decrypt data
    const encryptedBuffer = this.base64ToBuffer(encryptedData);
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      key,
      encryptedBuffer
    );

    return new TextDecoder().decode(decryptedBuffer);
  }

  // Utility: ArrayBuffer → Base64
  private bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Utility: Base64 → ArrayBuffer
  private base64ToBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
