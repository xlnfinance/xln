const structuredCloneWorks = (value: unknown): boolean => {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
};

const findStructuredCloneFailurePath = (
  value: unknown,
  path = '$',
  seen = new Set<object>(),
): string => {
  if (structuredCloneWorks(value)) return path;
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    typeof value === 'function' ||
    seen.has(value)
  ) {
    return path;
  }
  seen.add(value);

  const mapEntries = value instanceof Map ? [...value.entries()] : undefined;
  const children: Array<[string, unknown]> = mapEntries
    ? mapEntries.flatMap(([key, entry], index) => [
        [`${path}.<map-key:${index}>`, key],
        [`${path}.<map-value:${index}>`, entry],
      ])
    : value instanceof Set
      ? [...value].map((entry, index) => [`${path}.<set:${index}>`, entry])
      : Object.entries(value).map(([key, entry]) => [`${path}.${key}`, entry]);
  for (const [childPath, child] of children) {
    if (!structuredCloneWorks(child)) {
      return findStructuredCloneFailurePath(child, childPath, seen);
    }
  }

  if (!mapEntries) {
    // Some runtimes fail only when otherwise cloneable fields are combined
    // (usually because two fields share a host-backed object). Build the object
    // incrementally so the diagnostic names the field that introduces the
    // non-cloneable relationship instead of reporting the useless root `$`.
    const prefix: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      prefix[key] = child;
      if (!structuredCloneWorks(prefix)) return `${path}.${key}`;
    }
    return path;
  }
  const prefix = new Map<unknown, unknown>();
  for (const [index, entry] of mapEntries.entries()) {
    prefix.set(entry[0], entry[1]);
    if (structuredCloneWorks(prefix)) continue;
    if (entry[1] && typeof entry[1] === 'object' && !(entry[1] instanceof Map)) {
      const partial: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(entry[1])) {
        partial[key] = child;
        const candidate = new Map(prefix);
        candidate.set(entry[0], partial);
        if (!structuredCloneWorks(candidate)) {
          return `${path}.<map-entry:${index}>.${key}`;
        }
      }
    }
    return `${path}.<map-entry:${index}>`;
  }
  return path;
};

/**
 * Clone a consensus value or fail with the exact non-cloneable field path.
 *
 * State cloning is an isolation boundary. It must never fall back to a partial
 * manual copy because that can preserve aliases across candidate/live State.
 */
export const structuredCloneOrThrow = <T>(value: T, code: string): T => {
  try {
    return structuredClone(value);
  } catch (cause) {
    const path = findStructuredCloneFailurePath(value);
    const detail =
      cause instanceof Error ? `${cause.name}:${cause.message}` : String(cause);
    throw new Error(`${code}:path=${path}:cause=${detail}`, { cause });
  }
};
