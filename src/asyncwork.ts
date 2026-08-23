/** Small FIFO scheduler for expensive asynchronous work. */

interface PendingWork<T> {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
}

export class AsyncWorkQueue {
  private readonly pending: PendingWork<unknown>[] = [];
  private active = 0;

  constructor(private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("AsyncWorkQueue concurrency must be a positive integer.");
    }
  }

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run,
        resolve: resolve as PendingWork<unknown>["resolve"],
        reject,
      });
      this.pump();
    });
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const work = this.pending.shift();
      if (!work) return;
      this.active += 1;
      void work.run().then(work.resolve, work.reject).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }
}
