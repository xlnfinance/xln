/**
 * Pluggable Cryptography Provider Interface
 *
 * Enables envelope encryption for HTLC onion routing.
 * Implementations: RSA-OAEP (Phase 2), Kyber (Phase 3+)
 */

export interface CryptoKeyPair {
  publicKey: string;  // Base64-encoded public key
  privateKey: string; // Base64-encoded private key
}

export interface CryptoProvider {
  /**
   * Generate asymmetric key pair for entity
   * @returns Key pair (public for encryption, private for decryption)
   */
  generateKeyPair(): Promise<CryptoKeyPair>;

  /**
   * Encrypt data for recipient (asymmetric)
   * @param data - Plaintext data to encrypt
   * @param recipientPubKey - Recipient's public key (base64, or undefined to skip encryption)
   * @returns Encrypted data (base64)
   */
  encrypt(data: string, recipientPubKey: string | undefined): Promise<string>;

  /**
   * Decrypt data with private key
   * @param encryptedData - Ciphertext (base64)
   * @param privateKey - Entity's private key (base64)
   * @returns Decrypted plaintext
   */
  decrypt(encryptedData: string, privateKey: string): Promise<string>;
}
