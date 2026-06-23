import type { Locator, Page, TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

function writeScreenshotArtifact(testInfo: TestInfo, relativePath: string, bytes: Buffer | Uint8Array): void {
  const path = testInfo.outputPath(relativePath);
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
    const galleryPath = `ux-gallery/${normalizeName(options.ux.platform)}/${normalized}`;
    writeScreenshotArtifact(testInfo, galleryPath, bytes);
    writeUxMetadata(testInfo, galleryPath, options.ux);
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
    const galleryPath = `ux-gallery/${normalizeName(options.ux.platform)}/${normalized}`;
    writeScreenshotArtifact(testInfo, galleryPath, bytes);
    writeUxMetadata(testInfo, galleryPath, options.ux);
  }
}
