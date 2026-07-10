import type { Locator, Page, TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '-');
}

type UxScreenshotMetadata = {
  title: string;
  group: string;
  description: string;
  platform: 'desktop' | 'mobile' | string;
  tags?: string[];
};

type ScreenshotOptions = {
  fullPage?: boolean;
  ux?: UxScreenshotMetadata;
};

const STATIC_UX_SCREENSHOTS_ROOT = resolve(process.cwd(), 'tests', 'e2e', 'screenshots', 'ux-gallery');
const UPDATE_STATIC_UX_GALLERY = process.env['XLN_UPDATE_UX_GALLERY'] === '1';

function writeScreenshotArtifact(testInfo: TestInfo, relativePath: string, bytes: Buffer | Uint8Array): void {
  const path = testInfo.outputPath(relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function writeStaticUxArtifact(relativePath: string, bytes: Buffer | Uint8Array): void {
  if (!UPDATE_STATIC_UX_GALLERY) return;
  const path = join(STATIC_UX_SCREENSHOTS_ROOT, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function writeUxMetadata(testInfo: TestInfo, imageRelativePath: string, metadata: UxScreenshotMetadata): void {
  const payload = {
    ...metadata,
    sourceTest: testInfo.title,
    project: testInfo.project.name,
    capturedAt: Date.now(),
  };
  writeScreenshotArtifact(testInfo, `${imageRelativePath}.json`, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`));
}

function writeStaticUxMetadata(
  testInfo: TestInfo,
  imageRelativePath: string,
  metadata: UxScreenshotMetadata,
): void {
  if (!UPDATE_STATIC_UX_GALLERY) return;
  const payload = {
    ...metadata,
    sourceTest: testInfo.title,
    project: testInfo.project.name,
  };
  writeStaticUxArtifact(`${imageRelativePath}.json`, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`));
}

function writeUxGalleryArtifacts(
  testInfo: TestInfo,
  imageName: string,
  bytes: Buffer | Uint8Array,
  metadata: UxScreenshotMetadata,
): void {
  const galleryPath = `${normalizeName(metadata.platform)}/${imageName}`;
  writeScreenshotArtifact(testInfo, `ux-gallery/${galleryPath}`, bytes);
  writeUxMetadata(testInfo, `ux-gallery/${galleryPath}`, metadata);
  writeStaticUxArtifact(galleryPath, bytes);
  writeStaticUxMetadata(testInfo, galleryPath, metadata);
}

export async function capturePageScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: ScreenshotOptions = {},
): Promise<void> {
  const normalized = normalizeName(name);
  const bytes = await page.screenshot({
    fullPage: options.fullPage ?? true,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
  writeScreenshotArtifact(testInfo, normalized, bytes);
  if (options.ux) {
    writeUxGalleryArtifacts(testInfo, normalized, bytes, options.ux);
  }
}

export async function captureLocatorScreenshot(
  locator: Locator,
  testInfo: TestInfo,
  name: string,
  options: { ux?: UxScreenshotMetadata } = {},
): Promise<void> {
  const normalized = normalizeName(name);
  const bytes = await locator.screenshot({
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
  writeScreenshotArtifact(testInfo, normalized, bytes);
  if (options.ux) {
    writeUxGalleryArtifacts(testInfo, normalized, bytes, options.ux);
  }
}
