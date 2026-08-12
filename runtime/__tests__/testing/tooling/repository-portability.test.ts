import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const repoRoot = process.cwd();

describe('repository portability', () => {
  test('the legacy Whisper entrypoint resolves inside any checkout', () => {
    const aliasPath = join(repoRoot, 'ai/whisper-server.py');
    const target = lstatSync(aliasPath).isSymbolicLink()
      ? readlinkSync(aliasPath)
      : readFileSync(aliasPath, 'utf8').trim();

    expect(isAbsolute(target)).toBe(false);
    expect(existsSync(resolve(dirname(aliasPath), target))).toBe(true);

    const installer = readFileSync(join(repoRoot, 'ai/install-voice-paste.sh'), 'utf8');
    expect(installer).toContain('ln -sfn stt-server.py ~/xln/ai/whisper-server.py');
  });
});
