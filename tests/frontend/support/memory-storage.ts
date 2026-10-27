/**
 * In-memory Web Storage for Bun tests of browser modules. Bun runs every test
 * file in one process, so the returned restore must run when the file ends:
 * a storage left installed would let another file pass only after this one.
 */
export const installMemoryStorage = (name: 'localStorage' | 'sessionStorage' = 'localStorage'): (() => void) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  } satisfies Storage;
  Object.defineProperty(globalThis, name, { configurable: true, value: storage });
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  };
};
