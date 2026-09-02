import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStringify } from '../../../core/protocol/serialization';
import { executeCrossJEntityKindsGroupD } from './group-d';

const target = join(import.meta.dir, 'group-d-v1.json');
await writeFile(target, `${safeStringify(await executeCrossJEntityKindsGroupD(), 2)}\n`, 'utf8');
process.stdout.write(`${target}\n`);
