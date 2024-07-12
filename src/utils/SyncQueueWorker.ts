export default class SyncQueueWorker {
  private queue: Array<() => Promise<void>> = [];

  async sync(job: () => Promise<void>): Promise<void> {
    if (this.queue.length > 0) {
      this.queue.push(job);
    } else {
      this.queue = [job];
      while (this.queue.length > 0) {
        const jobToWork = this.queue.shift()!;
        await jobToWork();
      }
    }
  }
}
