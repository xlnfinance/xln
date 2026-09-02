import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStringify } from '../../../core/protocol/serialization';
import { executeCrossJOpeningLifecycleVector } from './lifecycle';

const target = join(import.meta.dir, 'lifecycle-v1.json');
await writeFile(target, `${safeStringify(await executeCrossJOpeningLifecycleVector(), 2)}\n`, 'utf8');
process.stdout.write(`${target}\n`);
