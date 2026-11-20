import { hashes } from '@noble/secp256k1';
import { SigningKey } from 'ethers';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const unexpectedSignature = (): never => {
  console.error('TEST_STATUS_SIGNATURE_ATTEMPTED');
  process.exit(77);
};

// The status child disables workers so this guard also covers the native
// backend used for inline Entity and Account signatures on Bun.
const require = createRequire(resolve('package.json'));
const native = require('secp256k1/bindings') as { ecdsaSign: typeof unexpectedSignature };
native.ecdsaSign = unexpectedSignature;
hashes.hmacSha256 = unexpectedSignature;
SigningKey.prototype.sign = unexpectedSignature;
