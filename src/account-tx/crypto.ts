/**
 * Mock signature validation for account consensus
 * Deterministic and simple for development/testing
 */

/**
 * Mock sign function - creates deterministic signatures
 */
export function signAccountFrame(
  entityId: string,
  frameHash: string,
  privateData: string = 'mock-private-key'
): string {
  // Create deterministic signature based on signer + frame hash
  const content = `${entityId}-${frameHash}-${privateData}`;
  const signature = `sig_${Buffer.from(content).toString('base64').slice(0, 32)}`;

  console.log(`✍️ Signed frame ${frameHash.slice(0, 10)} by ${entityId.slice(-4)}: ${signature.slice(0, 20)}...`);
  return signature;
}

/**
 * Mock verify function - validates signatures deterministically
 */
export function verifyAccountSignature(
  entityId: string,
  frameHash: string,
  signature: string,
  privateData: string = 'mock-private-key'
): boolean {
  const expectedSignature = signAccountFrame(entityId, frameHash, privateData);
  const isValid = signature === expectedSignature;

  if (isValid) {
    console.log(`✅ Valid signature from ${entityId.slice(-4)} for frame ${frameHash.slice(0, 10)}`);
  } else {
    console.log(`❌ Invalid signature from ${entityId.slice(-4)} for frame ${frameHash.slice(0, 10)}`);
    console.log(`   Expected: ${expectedSignature.slice(0, 20)}...`);
    console.log(`   Received: ${signature.slice(0, 20)}...`);
  }

  return isValid;
}

/**
 * Easy signer function that returns the entity ID from a signature
 */
export function getSignerFromSignature(signature: string, frameHash: string): string | null {
  // Parse signature to extract signer (mock implementation)
  // Real implementation would use cryptographic signature recovery

  if (!signature.startsWith('sig_')) {
    return null;
  }

  // For mock: signature format is sig_BASE64(entityId-frameHash-privateKey)
  try {
    const encoded = signature.slice(4); // Remove 'sig_' prefix
    const decoded = Buffer.from(encoded, 'base64').toString();
    const parts = decoded.split('-');

    if (parts.length >= 2 && parts[1] === frameHash) {
      return parts[0] || null; // Return entityId or null if empty
    }
  } catch (error) {
    console.log(`⚠️ Failed to parse signature: ${error}`);
  }

  return null;
}

/**
 * Validate multiple signatures for account frame
 */
export function validateAccountSignatures(
  frameHash: string,
  signatures: string[],
  expectedSigners: string[]
): { valid: boolean; validSigners: string[] } {
  const validSigners: string[] = [];

  for (const signature of signatures) {
    const signer = getSignerFromSignature(signature, frameHash);

    if (signer && expectedSigners.includes(signer)) {
      if (verifyAccountSignature(signer, frameHash, signature)) {
        validSigners.push(signer);
      }
    }
  }

  const allValid = validSigners.length === expectedSigners.length;

  console.log(`🔍 Signature validation: ${validSigners.length}/${expectedSigners.length} valid (${allValid ? 'PASS' : 'FAIL'})`);

  return { valid: allValid, validSigners };
}