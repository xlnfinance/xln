const crypto = require('crypto');
const cbor = require('cbor');
const rlp = require('rlp');

const NUM_RECORDS = 10**5; // Adjust if needed

// Generate a 128-bit random bigint
function randomBigInt128() {
  const buf = crypto.randomBytes(16); // 16 bytes = 128 bits
  return BigInt('0x' + buf.toString('hex'));
}

function generateRandomRecord() {
  const hashes = [
    crypto.randomBytes(32),
    crypto.randomBytes(32),
    crypto.randomBytes(32),
    crypto.randomBytes(32)
  ];
  const bigintVal = randomBigInt128();
  return {hashes, bigint: bigintVal};
}

// Convert bigint to a Buffer for RLP
function bigintToBuffer(bn) {
  let hex = bn.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex; 
  return Buffer.from(hex, 'hex');
}

// Convert Buffer to bigint after RLP decode
function bufferToBigint(buf) {
  if (buf.length === 0) return BigInt(0);
  return BigInt('0x' + buf.toString('hex'));
}

// Encode with CBOR
function encodeCbor(record) {
  // CBOR can handle buffers easily. For bigint, store as string (hex).
  return cbor.encode({
    hashes: record.hashes,
    bigint: record.bigint.toString(16)
  });
}

// Decode with CBOR
function decodeCbor(encoded) {
  const obj = cbor.decode(encoded);
  const bigintVal = BigInt('0x' + obj.bigint);
  return {hashes: obj.hashes, bigint: bigintVal};
}

// Encode with RLP
function encodeRlp(record) {
  // RLP expects arrays and buffers. We'll encode as [[h1,h2,h3,h4], bigintBuffer]
  return rlp.encode([
    record.hashes,
    bigintToBuffer(record.bigint)
  ]);
}

// Decode with RLP
function decodeRlp(encoded) {
  const decoded = rlp.decode(encoded);
  const hashes = decoded[0];
  const bigintVal = bufferToBigint(decoded[1]);
  return {hashes, bigint: bigintVal};
}

async function main() {
  console.log(`Generating ${NUM_RECORDS} records...`);
  const data = [];
  for (let i = 0; i < NUM_RECORDS; i++) {
    data.push(generateRandomRecord());
  }

  console.log("CBOR encoding...");
  let start = process.hrtime.bigint();
  const cborEncoded = data.map(encodeCbor);
  let end = process.hrtime.bigint();
  const cborEncodeTime = Number(end - start) / 1e9;

  console.log("CBOR decoding...");
  start = process.hrtime.bigint();
  const cborDecoded = cborEncoded.map(decodeCbor);
  end = process.hrtime.bigint();
  const cborDecodeTime = Number(end - start) / 1e9;

  console.log("RLP encoding...");
  start = process.hrtime.bigint();
  const rlpEncoded = data.map(encodeRlp);
  end = process.hrtime.bigint();
  const rlpEncodeTime = Number(end - start) / 1e9;

  console.log("RLP decoding...");
  start = process.hrtime.bigint();
  const rlpDecoded = rlpEncoded.map(decodeRlp);
  end = process.hrtime.bigint();
  const rlpDecodeTime = Number(end - start) / 1e9;

  // Basic correctness check on a small sample
  for (let i = 0; i < 100; i++) {
    const orig = data[i];
    const cDec = cborDecoded[i];
    const rDec = rlpDecoded[i];
    if (orig.bigint !== cDec.bigint ||
        orig.hashes.length !== cDec.hashes.length ||
        !orig.hashes.every((h, idx) => h.equals(cDec.hashes[idx]))) {
      console.error("CBOR mismatch at index:", i);
      break;
    }
    if (orig.bigint !== rDec.bigint ||
        orig.hashes.length !== rDec.hashes.length ||
        !orig.hashes.every((h, idx) => h.equals(rDec.hashes[idx]))) {
      console.error("RLP mismatch at index:", i);
      break;
    }
  }

  const cborTotalSize = cborEncoded.reduce((acc, e) => acc + e.length, 0);
  const rlpTotalSize = rlpEncoded.reduce((acc, e) => acc + e.length, 0);

  console.log("\n=== Performance Metrics ===");
  console.log("Total records:", NUM_RECORDS);

  console.log("\nCBOR:");
  console.log("  Encoding time (s):", cborEncodeTime.toFixed(3));
  console.log("  Decoding time (s):", cborDecodeTime.toFixed(3));
  console.log("  Avg size per record (bytes):", (cborTotalSize / NUM_RECORDS).toFixed(2));
  console.log("  Total encoded size (MB):", (cborTotalSize / (1024 * 1024)).toFixed(2));
  console.log("  Encode throughput (records/s):", (NUM_RECORDS / cborEncodeTime).toFixed(0));
  console.log("  Decode throughput (records/s):", (NUM_RECORDS / cborDecodeTime).toFixed(0));

  console.log("\nRLP:");
  console.log("  Encoding time (s):", rlpEncodeTime.toFixed(3));
  console.log("  Decoding time (s):", rlpDecodeTime.toFixed(3));
  console.log("  Avg size per record (bytes):", (rlpTotalSize / NUM_RECORDS).toFixed(2));
  console.log("  Total encoded size (MB):", (rlpTotalSize / (1024 * 1024)).toFixed(2));
  console.log("  Encode throughput (records/s):", (NUM_RECORDS / rlpEncodeTime).toFixed(0));
  console.log("  Decode throughput (records/s):", (NUM_RECORDS / rlpDecodeTime).toFixed(0));
}

main().catch(err => console.error(err));