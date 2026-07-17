import type { QaRunTestCategory, QaTestCategory } from './types';

export const QA_TEST_CATEGORY_TAGS = {
  functional: '@functional',
  resilience: '@resilience',
} as const satisfies Record<QaTestCategory, string>;

export type QaTaggedTest = {
  file: string;
  line: number | null;
  title: string;
  tags: string[];
};

export type QaTestCategoryViolation = QaTaggedTest & {
  code: 'QA_TEST_CATEGORY_MISSING' | 'QA_TEST_CATEGORY_CONFLICT';
};

const categoryTags = (tags: readonly string[]): QaTestCategory[] =>
  (Object.entries(QA_TEST_CATEGORY_TAGS) as Array<[QaTestCategory, string]>)
    .filter(([, tag]) => tags.includes(tag))
    .map(([category]) => category);

export const qaTestCategoryFromTags = (tags: readonly string[]): QaTestCategory | null => {
  const categories = categoryTags(tags);
  return categories.length === 1 ? categories[0]! : null;
};

export const inspectQaTestCategory = (test: QaTaggedTest): QaTestCategoryViolation | null => {
  const categories = categoryTags(test.tags);
  if (categories.length === 1) return null;
  return {
    ...test,
    code: categories.length === 0 ? 'QA_TEST_CATEGORY_MISSING' : 'QA_TEST_CATEGORY_CONFLICT',
  };
};

export const qaRunTestCategory = (categories: readonly QaTestCategory[]): QaRunTestCategory => {
  const unique = new Set(categories);
  if (unique.size === 0) return 'unknown';
  if (unique.size > 1) return 'mixed';
  return unique.values().next().value ?? 'unknown';
};

export const formatQaTestCategoryViolations = (violations: readonly QaTestCategoryViolation[]): string =>
  violations
    .map((violation) => {
      const location = `${violation.file}:${violation.line ?? 0}`;
      const tags = violation.tags.length > 0 ? violation.tags.join(',') : 'none';
      return `${violation.code} ${location} ${JSON.stringify(violation.title)} tags=${tags}`;
    })
    .join('\n');
