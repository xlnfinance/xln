import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('frontend/static/news/index.html', 'utf8');

test('same-origin news HTML escapes every remote story and comment body', () => {
  expect(source).toContain('return escapeHtml(md)');
  expect(source).toContain('${escapeHtml(item.text)}');
  expect(source).toContain('${escapeHtml(comment.text)}');
  expect(source).toContain('${escapeHtml(author)}</a>');
  expect(source).not.toContain('${item.text}</div>');
  expect(source).not.toContain('${comment.text || \'\'}</div>');
});

test('same-origin news links and executable ids are constrained before HTML insertion', () => {
  expect(source).toContain("url.protocol === 'http:' || url.protocol === 'https:'");
  expect(source).toContain('const storyId = safeInteger(story.id);');
  expect(source).toContain('const commentId = safeInteger(comment.id);');
  expect(source).toContain("window.open(safeExternalUrl(story.url), '_blank', 'noopener')");
  expect(source).not.toContain('href="${item.url}"');
  expect(source).not.toContain("window.open(story.url, '_blank')");
  expect(source).not.toContain('toggleComment(${comment.id})');
});
