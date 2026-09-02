import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStringify } from '../../../core/protocol/serialization';
import { executeLendingAccountSemanticVector } from './lending';
import { executeCrossJAccountSemanticVector } from './cross-j';
import { executeRebalanceSettlementAccountSemanticVector } from './rebalance-settlement';

const fixtures = [
  ['lending-v1.json', await executeLendingAccountSemanticVector()],
  ['cross-j-v1.json', await executeCrossJAccountSemanticVector()],
  ['rebalance-settlement-v1.json', await executeRebalanceSettlementAccountSemanticVector()],
] as const;
for (const [name, fixture] of fixtures) {
  const target = join(import.meta.dir, name);
  await writeFile(target, `${safeStringify(fixture, 2)}\n`, 'utf8');
  process.stdout.write(`${target}\n`);
}
