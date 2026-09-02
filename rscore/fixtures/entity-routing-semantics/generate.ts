import { safeStringify } from '../../../core/protocol/serialization';
import { executeEntityRoutingSemanticVectors } from './cases';

process.stdout.write(`${safeStringify(await executeEntityRoutingSemanticVectors(), 2)}\n`);

