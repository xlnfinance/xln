import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStringify } from '../../../protocol/serialization';
import { executeCrossJAccountSemanticVector } from '../../../../rscore/fixtures/account-semantics/cross-j';
