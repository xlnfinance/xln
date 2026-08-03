export type DocsCatalogKind = 'live' | 'archive';

export type DocsCatalogEntry = Readonly<{
  id: string;
  path: string;
  title: string;
  summary: string;
  role: string;
  status: string;
  audience: string;
  kind: DocsCatalogKind;
  sectionId: string;
  sectionTitle: string;
  featured: boolean;
  order: number;
  sectionOrder: number;
  url: string;
  sha256: string;
}>;

export type DocsCatalogSection = Readonly<{
  id: string;
  title: string;
  description: string;
  kind: DocsCatalogKind;
  order: number;
  items: readonly DocsCatalogEntry[];
}>;

export type DocsReadingPath = Readonly<{
  id: string;
  title: string;
  description: string;
  items: readonly DocsCatalogEntry[];
}>;

export type DocsCatalogManifest = Readonly<{
  schemaVersion: 1;
  contentSha256: string;
  counts: Readonly<{ total: number; live: number; archive: number }>;
  featured: readonly DocsCatalogEntry[];
  readingPaths: readonly DocsReadingPath[];
  sections: readonly DocsCatalogSection[];
  items: readonly DocsCatalogEntry[];
}>;

export declare const DOCS_CATALOG_SCHEMA_VERSION: 1;
export declare const isSafeDocsPath: (value: unknown) => value is string;
export declare const docsCatalogUrl: (path: string) => string;
export declare const validateDocsCatalogManifest: (value: unknown) => readonly string[];
export declare const parseDocsCatalogManifest: (value: string | unknown) => DocsCatalogManifest;
