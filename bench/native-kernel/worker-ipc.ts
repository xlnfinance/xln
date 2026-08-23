const sizes = [1024 * 97, 16_384 * 97];

if (!Bun.isMainThread) {
  self.onmessage = (event: MessageEvent<{ id: number; bytes: Uint8Array }>) => {
    postMessage(event.data, [event.data.bytes.buffer]);
  };
} else {
  const worker = new Worker(new URL(import.meta.url).href);
  const pending = new Map<number, (value: Uint8Array) => void>();
  worker.onmessage = (event: MessageEvent<{ id: number; bytes: Uint8Array }>) => {
    const resolve = pending.get(event.data.id);
    if (!resolve) throw new Error(`missing ${event.data.id}`);
    pending.delete(event.data.id);
    resolve(event.data.bytes);
  };
  let nextId = 0;
  const roundTrip = (length: number): Promise<Uint8Array> => {
    const id = nextId += 1;
    const bytes = new Uint8Array(length);
    return new Promise(resolve => {
      pending.set(id, resolve);
      worker.postMessage({ id, bytes }, [bytes.buffer]);
    });
  };
  for (const size of sizes) {
    await roundTrip(size);
    const samples: number[] = [];
    for (let round = 0; round < 25; round += 1) {
      const startedAt = performance.now();
      const returned = await roundTrip(size);
      if (returned.length !== size) throw new Error('size');
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    console.log(JSON.stringify({
      schema: 'xln-native-worker-transfer-v1',
      bytesRoundTrip: size,
      medianMs: samples[Math.floor(samples.length / 2)],
      p95Ms: samples[Math.floor(samples.length * 0.95)],
    }));
  }
  worker.terminate();
}
