import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStringify } from '../../../protocol/serialization';

export const policyConfig = async () => {
  const path = join(process.cwd(), 'jurisdictions', `.native-policy-${randomUUID()}.config.ts`);
  const parent = safeStringify(join(process.cwd(), 'jurisdictions/hardhat.config.ts'));
  // This is an ordinary selected Hardhat config, with a real native timer.
  // Its environment-resolved policy must be sealed independently of source.
  await writeFile(
    path,
    `import config from ${parent};\nexport default { ...config, ignition: { ...config.ignition, timeBeforeBumpingFees: Number(process.env['XLN_PROBE_BUMP_MS'] || '1000') } };\n`,
  );
  return { path, close: () => rm(path) };
};
