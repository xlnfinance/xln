import type { DocsCatalogKind } from './packages/client-core/docs-catalog-contract.js';

export type ReadingPathDefinition = Readonly<{
  id: string;
  title: string;
  description: string;
  items: readonly string[];
}>;

export type SectionDefinition = Readonly<{
  id: string;
  title: string;
  description: string;
  kind: DocsCatalogKind;
  order: number;
  items?: readonly string[];
  prefixes?: readonly string[];
}>;

export declare const FEATURED_DOC_IDS: readonly string[];
export declare const READING_PATHS: readonly ReadingPathDefinition[];
export declare function normalizeDocId(value: unknown): string;
export declare function getSectionMeta(sectionId: string): SectionDefinition | null;
export declare function getSectionOrder(sectionId: string): number;
export declare function getSectionTitle(sectionId: string): string;
export declare function getSectionKind(sectionId: string): DocsCatalogKind;
export declare function getDocOrder(docId: string): number;
export declare function isFeaturedDoc(docId: string): boolean;
export declare function classifyDoc(docId: string): string;
export declare function getSectionDefinitions(): readonly SectionDefinition[];
