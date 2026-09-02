import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStringify } from '../../../core/protocol/serialization';
import { executeSameJFinancialEntitySemanticVector } from './same-j-financial';

const target = join(import.meta.dir, 'same-j-financial-v1.json');
await writeFile(target, `${safeStringify(await executeSameJFinancialEntitySemanticVector(), 2)}\n`, 'utf8');
process.stdout.write(`${target}\n`);
