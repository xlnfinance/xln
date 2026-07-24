import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('contract artifact publication', () => {
  test('keeps the live TypeChain tree readable until a complete replacement exists', () => {
    const sync = readFileSync('scripts/sync-contract-artifacts.sh', 'utf8');
    const config = readFileSync('jurisdictions/hardhat.config.ts', 'utf8');
    const generator = readFileSync('jurisdictions/scripts/generate-typechain.cjs', 'utf8');

    expect(config).toContain('process.env.XLN_TYPECHAIN_OUT_DIR || "typechain-types"');
    expect(generator).toContain("process.env.XLN_TYPECHAIN_OUT_DIR || 'typechain-types'");
    expect(sync).toContain('export XLN_TYPECHAIN_OUT_DIR="$TYPECHAIN_BUILD_DIR"');
    expect(sync).toContain("rsync -a --checksum --exclude='/index.ts'");
    expect(sync).toContain('cmp -s "$TYPECHAIN_BUILD_PATH/index.ts" "$TYPECHAIN_PUBLISH_PATH/index.ts"');
    expect(sync).toContain('mv "$TYPECHAIN_PUBLISH_PATH/.index.ts.next" "$TYPECHAIN_PUBLISH_PATH/index.ts"');
    expect(sync).toContain("rsync -a --checksum --delete-after --exclude='/index.ts'");
    expect(sync).not.toContain('rm -rf "$TYPECHAIN_PUBLISH_PATH"');
    expect(sync.indexOf('scripts/generate-typechain.cjs')).toBeLessThan(
      sync.indexOf("rsync -a --checksum --exclude='/index.ts'"),
    );
    expect(sync.indexOf("rsync -a --checksum --exclude='/index.ts'")).toBeLessThan(
      sync.indexOf('mv "$TYPECHAIN_PUBLISH_PATH/.index.ts.next"'),
    );
    expect(sync.indexOf('mv "$TYPECHAIN_PUBLISH_PATH/.index.ts.next"')).toBeLessThan(
      sync.indexOf("rsync -a --checksum --delete-after --exclude='/index.ts'"),
    );
  });
});
