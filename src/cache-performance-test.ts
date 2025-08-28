import { createCachedMPTStorage } from './entity-cached-storage.js';
import { createMPTStorage } from './entity-mpt.js';
import { EntityStorage } from './types.js';
import fs from 'fs';

// Performance test comparing cached vs non-cached storage
export async function testCachePerformance() {
  console.log('🧪 Starting cache performance test...\n');

  // Clean up any existing test data
  if (fs.existsSync('db/test-cached')) {
    fs.rmSync('db/test-cached', { recursive: true });
  }
  if (fs.existsSync('db/test-regular')) {
    fs.rmSync('db/test-regular', { recursive: true });
  }

  const cachedStorage = await createCachedMPTStorage('db/test-cached');
  const regularStorage = await createMPTStorage('db/test-regular');

  // Test data
  const testData = Array.from({ length: 100 }, (_, i) => ({
    type: 'user',
    key: `user_${i}`,
    value: {
      id: `user_${i}`,
      name: `User ${i}`,
      balance: BigInt(1000 + i),
      transactions: Array.from({ length: 10 }, (_, j) => `tx_${i}_${j}`),
    },
  }));

  // Benchmark function
  const benchmark = async (storage: EntityStorage, name: string, operations: () => Promise<void>) => {
    const start = performance.now();
    await operations();
    const end = performance.now();
    console.log(`${name}: ${(end - start).toFixed(2)}ms`);
    return end - start;
  };

  // Test 1: Write performance
  console.log('📝 Write Performance Test:');
  const cachedWriteTime = await benchmark(cachedStorage, 'Cached Storage (write)', async () => {
    for (const item of testData) {
      await cachedStorage.set(item.type, item.key, item.value);
    }
  });

  const regularWriteTime = await benchmark(regularStorage, 'Regular Storage (write)', async () => {
    for (const item of testData) {
      await regularStorage.set(item.type, item.key, item.value);
    }
  });

  // Test 2: First read performance (cold cache)
  console.log('\n🔍 Cold Read Performance Test:');
  const cachedColdReadTime = await benchmark(cachedStorage, 'Cached Storage (cold read)', async () => {
    for (const item of testData) {
      await cachedStorage.get(item.type, item.key);
    }
  });

  const regularColdReadTime = await benchmark(regularStorage, 'Regular Storage (cold read)', async () => {
    for (const item of testData) {
      await regularStorage.get(item.type, item.key);
    }
  });

  // Test 3: Hot read performance (warm cache)
  console.log('\n🔥 Hot Read Performance Test:');
  const cachedHotReadTime = await benchmark(cachedStorage, 'Cached Storage (hot read)', async () => {
    for (const item of testData) {
      await cachedStorage.get(item.type, item.key);
    }
  });

  const regularHotReadTime = await benchmark(regularStorage, 'Regular Storage (hot read)', async () => {
    for (const item of testData) {
      await regularStorage.get(item.type, item.key);
    }
  });

  // Test 4: Mixed workload (realistic consensus scenario)
  console.log('\n🔄 Mixed Workload Test (reads + writes):');
  const cachedMixedTime = await benchmark(cachedStorage, 'Cached Storage (mixed)', async () => {
    for (let i = 0; i < 50; i++) {
      // Read existing data
      await cachedStorage.get('user', `user_${i}`);
      await cachedStorage.get('user', `user_${(i + 25) % 100}`);
      
      // Update some data
      await cachedStorage.set('user', `user_${i}`, {
        ...testData[i].value,
        balance: testData[i].value.balance + BigInt(i),
      });
    }
  });

  const regularMixedTime = await benchmark(regularStorage, 'Regular Storage (mixed)', async () => {
    for (let i = 0; i < 50; i++) {
      // Read existing data  
      await regularStorage.get('user', `user_${i}`);
      await regularStorage.get('user', `user_${(i + 25) % 100}`);
      
      // Update some data
      await regularStorage.set('user', `user_${i}`, {
        ...testData[i].value,
        balance: testData[i].value.balance + BigInt(i),
      });
    }
  });

  // Show cache stats if available
  if ('getCacheStats' in cachedStorage) {
    console.log('\n📊 Cache Statistics:');
    const stats = (cachedStorage as any).getCacheStats();
    console.log(JSON.stringify(stats, null, 2));
  }

  // Performance summary
  console.log('\n🏆 Performance Summary:');
  console.log(`Write Performance: ${(regularWriteTime / cachedWriteTime).toFixed(2)}x`);
  console.log(`Cold Read Performance: ${(regularColdReadTime / cachedColdReadTime).toFixed(2)}x`);  
  console.log(`Hot Read Performance: ${(regularHotReadTime / cachedHotReadTime).toFixed(2)}x`);
  console.log(`Mixed Workload Performance: ${(regularMixedTime / cachedMixedTime).toFixed(2)}x`);

  // Clean up
  fs.rmSync('db/test-cached', { recursive: true });
  fs.rmSync('db/test-regular', { recursive: true });

  console.log('\n✅ Cache performance test completed!');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testCachePerformance().catch(console.error);
}
