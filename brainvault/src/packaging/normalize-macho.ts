#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
if (path === undefined) throw new Error('BRAINVAULT_MACHO_PATH_REQUIRED');
const binary = readFileSync(path);
const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
if (view.getUint32(0, true) !== 0xfeedfacf) throw new Error('BRAINVAULT_MACHO64_REQUIRED');
const commandCount = view.getUint32(16, true);
let offset = 32;
let uuidOffset = -1;
for (let index = 0; index < commandCount; index += 1) {
  const command = view.getUint32(offset, true);
  const size = view.getUint32(offset + 4, true);
  if (size < 8 || offset + size > binary.length) throw new Error('BRAINVAULT_MACHO_COMMAND_INVALID');
  if (command === 0x1b) uuidOffset = offset + 8;
  offset += size;
}
if (uuidOffset === -1) throw new Error('BRAINVAULT_MACHO_UUID_MISSING');
binary.fill(0, uuidOffset, uuidOffset + 16);
const digest = createHash('sha256').update(binary).digest();
digest.copy(binary, uuidOffset, 0, 16);
writeFileSync(path, binary, { mode: 0o755 });
