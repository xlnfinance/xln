import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStringify } from '../../../core/protocol/serialization';
import { executeEntityResidentGroupEVector } from './group-e';

const target = join(import.meta.dir, 'group-e-v1.json');
await writeFile(target, `${safeStringify(await executeEntityResidentGroupEVector(), 2)}\n`, 'utf8');
process.stdout.write(`${target}\n`);
