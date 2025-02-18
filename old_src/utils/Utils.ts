// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function deepClone(obj: any) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  const clone = Object.assign({}, obj);

  Object.keys(clone).forEach((key) => (clone[key] = typeof obj[key] === 'object' ? deepClone(obj[key]) : obj[key]));

  if (Array.isArray(obj)) {
    clone.length = obj.length;
    return Array.from(clone);
  }

  return clone;
}

export function getTimestamp(): number {
  // get current timestamp in milliseconds
  return Date.now();
}

export function sleep(ms: number = 300): Promise<void> {
  return new Promise((res) => {
    setTimeout(() => res(), ms);
  });
}


