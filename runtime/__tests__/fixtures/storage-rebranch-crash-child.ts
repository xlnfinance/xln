import { Level } from 'level';

import { withRebranchedValues } from '../../storage/rebranched-db';

const [dbPath, stage] = Bun.argv.slice(2);
if (!dbPath || !stage) throw new Error('rebranch crash fixture requires db path and stage');

const logicalKey = Buffer.from([0x22, 0x01]);
const patternedValue = (bytes: number, salt: number): Buffer => {
  const value = Buffer.allocUnsafe(bytes);
  for (let index = 0; index < bytes; index += 1) value[index] = (index + salt) % 251;
  return value;
};

const raw = new Level<Buffer, Buffer>(dbPath, {
  keyEncoding: 'buffer',
  valueEncoding: 'buffer',
});
await raw.open();
const db = withRebranchedValues(raw);

switch (stage) {
  case 'split':
    await db.put(logicalKey, patternedValue(40_000, 11), { sync: true });
    break;
  case 'shrink':
    await db.put(logicalKey, patternedValue(20_000, 29), { sync: true });
    break;
  case 'collapse':
    await db.put(logicalKey, patternedValue(9_999, 47), { sync: true });
    break;
  case 'regrow':
    await db.put(logicalKey, patternedValue(32_000, 71), { sync: true });
    break;
  case 'delete':
    await db.del(logicalKey, { sync: true });
    break;
  default:
    throw new Error(`unknown rebranch crash stage: ${stage}`);
}

// Kill with the LevelDB handle still open. The parent must be able to reopen
// immediately and observe either the exact durable stage or fail loudly.
process.kill(process.pid, 'SIGKILL');
throw new Error(`SIGKILL did not stop rebranch crash fixture at ${stage}`);
