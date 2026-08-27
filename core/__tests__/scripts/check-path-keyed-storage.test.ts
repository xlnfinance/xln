import { describe, expect, test } from 'bun:test';

import {
  findRustPathKeyViolations,
  findTypeScriptPathKeyViolations,
} from '../../scripts/checks/consensus/state/check-path-keyed-storage';

describe('path-keyed storage gate', () => {
  test('rejects TypeScript physical writes with any content-digest provenance', () => {
    const source = `
      db.put(keyFromHash(payloadHash), payload);
      database.write(sha256(payload), payload);
      const key = keyCertifiedNode(nodeHash);
      rows.push({ key, value });
      db.put(keyByPath(entityId, accountId, payloadHash), payload);
    `;
    expect(findTypeScriptPathKeyViolations(source)).toHaveLength(4);
  });

  test('allows commitments, verification, reads, and stable path keys', () => {
    const source = `
      const payloadHash = computeDigest(payload);
      verifyHash(payload, payloadHash);
      db.get(keyFromHash(payloadHash));
      db.put(keyByPath(entityId, accountId, slot), payload);
      const row = { key: keyByPath(runtimeHeight, outputIndex), value: payload };
    `;
    expect(findTypeScriptPathKeyViolations(source)).toEqual([]);
  });

  test('rejects Rust database writes with a digest even below an owner path', () => {
    const source = `
      db.put(key_from_hash(payload_hash), payload)?;
      storage_writer.write(hash_payload(payload), payload)?;
      let value = db.get(key_from_hash(payload_hash))?;
      write_batch.put(key_by_path(entity_id, account_id, payload_hash), payload)?;
      db.put(
        key_by_path(owner_id, node_digest),
        payload,
      )?;
    `;
    expect(findRustPathKeyViolations(source)).toHaveLength(4);
  });
});
