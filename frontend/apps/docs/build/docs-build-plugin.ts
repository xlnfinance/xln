import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Plugin } from 'vite';

import { parseDocsCatalogManifest } from '../../../packages/client-core/docs-catalog-contract.js';
import type { ReactViteSurfaceContract } from '../../../packages/build-contracts/vite-surfaces';

export const docsStaticAssets = (staticRoot: string): readonly string[] => readdirSync(staticRoot)
  .filter(name => /^llms(?:[_-].+)?\.txt$/.test(name))
  .toSorted((left, right) => left.localeCompare(right));

const copyDocsAssets = (staticRoot: string, outputRoot: string): string => {
  const catalogRoot = join(staticRoot, 'docs-catalog');
  const manifestPath = join(catalogRoot, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`REACT_DOCS_CATALOG_MISSING:${manifestPath}`);
  const manifest = parseDocsCatalogManifest(readFileSync(manifestPath, 'utf8'));
  cpSync(catalogRoot, join(outputRoot, 'docs-catalog'), { recursive: true, force: true });
  const imageRoot = join(staticRoot, 'img');
  if (!existsSync(imageRoot)) throw new Error(`REACT_DOCS_IMAGE_ROOT_MISSING:${imageRoot}`);
  cpSync(imageRoot, join(outputRoot, 'img'), { recursive: true, force: true });
  const llmsFiles = docsStaticAssets(staticRoot);
  if (!llmsFiles.includes('llms.txt')) throw new Error(`REACT_DOCS_LLMS_MISSING:${join(staticRoot, 'llms.txt')}`);
  llmsFiles.forEach(file => {
    const destination = join(outputRoot, basename(file));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(staticRoot, file), destination);
  });
  const favicon = join(staticRoot, 'favicon.ico');
  if (!existsSync(favicon)) throw new Error(`REACT_DOCS_FAVICON_MISSING:${favicon}`);
  copyFileSync(favicon, join(outputRoot, 'favicon.ico'));
  return manifest.contentSha256;
};

export const createDocsBuildPlugin = (
  staticRoot: string,
  contract: ReactViteSurfaceContract,
): Plugin => ({
  name: 'xln-docs-assets',
  closeBundle() {
    if (contract.surface !== 'docs' && contract.surface !== 'all') return;
    copyDocsAssets(staticRoot, contract.outDir);
  },
});
