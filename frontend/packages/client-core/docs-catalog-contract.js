export const DOCS_CATALOG_SCHEMA_VERSION = 1;

const ENTRY_KEYS = [
  'id', 'path', 'title', 'summary', 'role', 'status', 'audience', 'kind', 'sectionId',
  'sectionTitle', 'featured', 'order', 'sectionOrder', 'url', 'sha256',
];

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, expected, label) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.join('\n') === wanted.join('\n') ? [] : [`${label}_KEYS_INVALID:${actual.join(',')}`];
};

export const isSafeDocsPath = value => {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\')) return false;
  return value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
};

export const docsCatalogUrl = path => {
  if (!isSafeDocsPath(path)) throw new Error(`DOCS_CATALOG_PATH_INVALID:${String(path)}`);
  return `/docs-catalog/${path.split('/').map(encodeURIComponent).join('/')}`;
};

const validateEntry = (value, label) => {
  if (!isRecord(value)) return [`${label}_INVALID`];
  const errors = exactKeys(value, ENTRY_KEYS, label);
  const strings = ['id', 'path', 'title', 'summary', 'role', 'status', 'audience', 'sectionId', 'sectionTitle', 'url'];
  strings.forEach(key => {
    if (typeof value[key] !== 'string') errors.push(`${label}_${key.toUpperCase()}_INVALID`);
  });
  if (!isSafeDocsPath(value.path) || !value.path.endsWith('.md')) errors.push(`${label}_PATH_INVALID`);
  if (value.kind !== 'live' && value.kind !== 'archive') errors.push(`${label}_KIND_INVALID`);
  if (typeof value.featured !== 'boolean') errors.push(`${label}_FEATURED_INVALID`);
  if (!Number.isSafeInteger(value.order) || value.order < 0) errors.push(`${label}_ORDER_INVALID`);
  if (!Number.isSafeInteger(value.sectionOrder) || value.sectionOrder < 0) errors.push(`${label}_SECTION_ORDER_INVALID`);
  if (!isSha256(value.sha256)) errors.push(`${label}_SHA256_INVALID`);
  if (typeof value.id === 'string' && typeof value.url === 'string') {
    const expectedUrl = `/docs?doc=${encodeURIComponent(value.id)}`;
    if (value.url !== expectedUrl) errors.push(`${label}_URL_INVALID`);
  }
  return errors;
};

const validateEntryCollection = (value, label, entries) => {
  if (!Array.isArray(value)) return [`${label}_INVALID`];
  const errors = [];
  value.forEach((entry, index) => {
    errors.push(...validateEntry(entry, `${label}_${index}`));
    if (!isRecord(entry) || typeof entry.id !== 'string') return;
    const canonical = entries.get(entry.id);
    if (!canonical || JSON.stringify(entry) !== JSON.stringify(canonical)) {
      errors.push(`${label}_${index}_ENTRY_MISMATCH`);
    }
  });
  return errors;
};

export const validateDocsCatalogManifest = value => {
  if (!isRecord(value)) return ['DOCS_CATALOG_NOT_OBJECT'];
  const errors = exactKeys(
    value,
    ['schemaVersion', 'contentSha256', 'counts', 'featured', 'readingPaths', 'sections', 'items'],
    'DOCS_CATALOG',
  );
  if (value.schemaVersion !== DOCS_CATALOG_SCHEMA_VERSION) errors.push('DOCS_CATALOG_SCHEMA_UNSUPPORTED');
  if (!isSha256(value.contentSha256)) errors.push('DOCS_CATALOG_CONTENT_SHA256_INVALID');
  if (!Array.isArray(value.items)) return [...errors, 'DOCS_CATALOG_ITEMS_INVALID'].sort();

  const entries = new Map();
  const paths = new Set();
  const urls = new Set();
  value.items.forEach((entry, index) => {
    const label = `DOCS_CATALOG_ITEM_${index}`;
    errors.push(...validateEntry(entry, label));
    if (!isRecord(entry) || typeof entry.id !== 'string') return;
    if (entries.has(entry.id)) errors.push(`${label}_ID_DUPLICATE`);
    entries.set(entry.id, entry);
    if (typeof entry.path === 'string') {
      if (paths.has(entry.path)) errors.push(`${label}_PATH_DUPLICATE`);
      paths.add(entry.path);
    }
    if (typeof entry.url === 'string') {
      if (urls.has(entry.url)) errors.push(`${label}_URL_DUPLICATE`);
      urls.add(entry.url);
    }
  });

  if (!isRecord(value.counts)) errors.push('DOCS_CATALOG_COUNTS_INVALID');
  else {
    errors.push(...exactKeys(value.counts, ['total', 'live', 'archive'], 'DOCS_CATALOG_COUNTS'));
    const live = value.items.filter(entry => isRecord(entry) && entry.kind === 'live').length;
    const archive = value.items.filter(entry => isRecord(entry) && entry.kind === 'archive').length;
    if (value.counts.total !== value.items.length) errors.push('DOCS_CATALOG_COUNT_TOTAL_MISMATCH');
    if (value.counts.live !== live) errors.push('DOCS_CATALOG_COUNT_LIVE_MISMATCH');
    if (value.counts.archive !== archive) errors.push('DOCS_CATALOG_COUNT_ARCHIVE_MISMATCH');
  }

  errors.push(...validateEntryCollection(value.featured, 'DOCS_CATALOG_FEATURED', entries));
  if (!Array.isArray(value.readingPaths)) errors.push('DOCS_CATALOG_READING_PATHS_INVALID');
  else value.readingPaths.forEach((path, index) => {
    const label = `DOCS_CATALOG_READING_PATH_${index}`;
    if (!isRecord(path)) return errors.push(`${label}_INVALID`);
    errors.push(...exactKeys(path, ['id', 'title', 'description', 'items'], label));
    ['id', 'title', 'description'].forEach(key => {
      if (typeof path[key] !== 'string') errors.push(`${label}_${key.toUpperCase()}_INVALID`);
    });
    errors.push(...validateEntryCollection(path.items, `${label}_ITEMS`, entries));
  });
  if (!Array.isArray(value.sections)) errors.push('DOCS_CATALOG_SECTIONS_INVALID');
  else value.sections.forEach((section, index) => {
    const label = `DOCS_CATALOG_SECTION_${index}`;
    if (!isRecord(section)) return errors.push(`${label}_INVALID`);
    errors.push(...exactKeys(section, ['id', 'title', 'description', 'kind', 'order', 'items'], label));
    ['id', 'title', 'description'].forEach(key => {
      if (typeof section[key] !== 'string') errors.push(`${label}_${key.toUpperCase()}_INVALID`);
    });
    if (section.kind !== 'live' && section.kind !== 'archive') errors.push(`${label}_KIND_INVALID`);
    if (!Number.isSafeInteger(section.order) || section.order < 0) errors.push(`${label}_ORDER_INVALID`);
    errors.push(...validateEntryCollection(section.items, `${label}_ITEMS`, entries));
  });
  return errors.sort();
};

export const parseDocsCatalogManifest = value => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const errors = validateDocsCatalogManifest(parsed);
  if (errors.length > 0) throw new Error(`DOCS_CATALOG_INVALID:${errors.join(',')}`);
  return parsed;
};
