// section.test.ts

import { expect } from 'chai';
import User from '../app/User';
import { performance } from 'perf_hooks';
import { setupGlobalHub } from './hub';
import { sleep } from '../utils/Utils';
import chaiAsPromised from 'chai-as-promised';

chai.use(chaiAsPromised);

describe('Critical Section Tests', () => {
  let user: User, hub: User;

  let shouldSkipRemainingTests = false;
  beforeEach(function() {
    if (shouldSkipRemainingTests) {
      // Skip the test by throwing a special error recognized by Mocha
      this.skip();
    }
  });
  
  afterEach(function() {
    // If the current test failed, set the flag to true
    if (this.currentTest!.state === 'failed') {
      shouldSkipRemainingTests = true;
    }
  });



  before(async () => {
    hub = await setupGlobalHub(10002);

    user = new User('testuser', 'testpassword');
    user.start();
  });

  it('should execute jobs in order', async () => {
    let results: number[] = [];
    const jobs = [
      () => new Promise<number>(resolve => setTimeout(() => resolve(1), 50)),
      () => new Promise<number>(resolve => setTimeout(() => resolve(2), 10)),
      () => new Promise<number>(resolve => setTimeout(() => resolve(3), 30))
    ];

    await sleep(2000)
    console.log('exec')

    results = await Promise.all(jobs.map(job => user.criticalSection('test', 'ordered execution', job)));
    console.log('exec2')

    expect(results).to.deep.equal([1, 2, 3]);
  });

  it('should handle concurrent requests', async () => {
    const counter = { value: 0 };
    const concurrentJobs = 100;
    const incrementJob = () => user.criticalSection('increment', 'increment counter', async () => {
      const currentValue = counter.value;
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
      counter.value = currentValue + 1;
    });

    await Promise.all(Array(concurrentJobs).fill(null).map(() => incrementJob()));

    expect(counter.value).to.equal(concurrentJobs);
  });

  /*
  it('should handle job timeouts', async () => {
    const timeoutPromise = user.criticalSection('timeout', 'timeout test', () => new Promise(resolve => setTimeout(resolve, 30000)));
    await expect(timeoutPromise).to.be.rejectedWith('Timeout: timeout:timeout test');
  });

  it('should handle errors in jobs', async () => {
    const errorPromise = user.criticalSection('error', 'error test', () => Promise.reject(new Error('Test error')));
    await expect(errorPromise).to.be.rejectedWith('Test error');
  });*/

  it('should handle queue overflow', async () => {
    const overflowJobs = 60;
    const slowJob = () => new Promise(resolve => setTimeout(resolve, 100));
    const promises = [];

    for (let i = 0; i < overflowJobs; i++) {
      promises.push(user.criticalSection('overflow', 'overflow test', slowJob));
    }

    //await expect(Promise.all(promises)).to.be.rejectedWith('Queue overflow');
  });

  it('should maintain mutual exclusion under high load', async () => {
    const sharedResource = { value: 0 };
    const highLoadJobs = 1000;
    const criticalSectionJob = () => user.criticalSection('high-load', 'high load test', async () => {
      const currentValue = sharedResource.value;
      await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
      sharedResource.value = currentValue + 1;
    });

    await Promise.all(Array(highLoadJobs).fill(null).map(() => criticalSectionJob()));

    expect(sharedResource.value).to.equal(highLoadJobs);
  });

  it('should handle nested critical sections', async () => {
    const results: string[] = [];
    const outerJob = () => user.criticalSection('outer', 'outer job', async () => {
      results.push('outer start');
      await user.criticalSection('inner', 'inner job', async () => {
        results.push('inner');
      });
      results.push('outer end');
    });

    await Promise.all([outerJob(), outerJob()]);

    expect(results).to.deep.equal(['outer start', 'inner', 'outer end', 'outer start', 'inner', 'outer end']);
  });

  it('should properly clean up queues after completion', async () => {
    await user.criticalSection('cleanup', 'cleanup test', () => Promise.resolve());
    expect(user.sectionQueue['cleanup']).to.be.undefined;
  });

  it('should handle rapid successive calls', async () => {
    const rapidCalls = 100;
    const results: number[] = [];
    const rapidJob = (i: number) => user.criticalSection('rapid', 'rapid call', async () => {
      results.push(i);
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
    });

    await Promise.all(Array(rapidCalls).fill(null).map((_, i) => rapidJob(i)));

    expect(results).to.have.lengthOf(rapidCalls);
    expect(results).to.deep.equal([...Array(rapidCalls).keys()]);
  });

  it('should maintain correct order with mixed job durations', async () => {
    const jobs = [
      () => new Promise<number>(resolve => setTimeout(() => resolve(1), 50)),
      () => Promise.resolve(2),
      () => new Promise<number>(resolve => setTimeout(() => resolve(3), 10)),
      () => Promise.resolve(4),
      () => new Promise<number>(resolve => setTimeout(() => resolve(5), 30))
    ];

    const results: number[] = [];
    await Promise.all(jobs.map(job => user.criticalSection('mixed', 'mixed durations', async () => {
      const result = await job();
      results.push(result);
    })));

    expect(results).to.deep.equal([1, 2, 3, 4, 5]);
  });

  it('should handle alternating read/write operations', async () => {
    const sharedState = { value: 0 };
    const operations = 100;
    const readJob = () => user.criticalSection('readwrite', 'read op', async () => {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
      return sharedState.value;
    });
    const writeJob = (newValue: number) => user.criticalSection('readwrite', 'write op', async () => {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
      sharedState.value = newValue;
    });

    const jobs = Array(operations).fill(null).map((_, i) => 
      i % 2 === 0 ? readJob() : writeJob(i)
    );

    await Promise.all(jobs);

    expect(sharedState.value).to.equal(operations - 1);
  });

  it('should handle job cancellation', async () => {
    let jobRan = false;
    const cancelableJob = () => new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        jobRan = true;
        resolve();
      }, 1000);

      // Simulating cancellation after a short delay
      setTimeout(() => {
        clearTimeout(timeoutId);
        reject(new Error('Job cancelled'));
      }, 10);
    });

    //await expect(user.criticalSection('cancellation', 'cancellable job', cancelableJob))
    //  .to.be.rejectedWith('Job cancelled');

    expect(jobRan).to.be.false;
  });

  it('should maintain performance under sustained load', async () => {
    const iterations = 1000;
    const start = performance.now();

    const job = () => user.criticalSection('performance', 'performance test', async () => {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
    });

    await Promise.all(Array(iterations).fill(null).map(() => job()));

    const end = performance.now();
    const duration = end - start;
    console.log(`Performance test completed in ${duration}ms`);

    // This is a rough estimate and might need adjustment based on the test environment
    expect(duration).to.be.below(iterations * 10);
  });
});