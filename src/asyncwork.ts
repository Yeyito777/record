/**
 * Small scheduler for expensive asynchronous work: FIFO, or by priority
 * (lowest first, re-evaluated whenever a slot frees) for work given one.
 */

interface PendingWork<T> {
  run: () => Promise<T>;
  priority?: () => number;
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

  enqueue<T>(run: () => Promise<T>, priority?: () => number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run,
        priority,
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

  /** The first pending work of the lowest priority (unprioritized work counts as 0). */
  private next(): PendingWork<unknown> | undefined {
    let best = -1;
    let bestPriority = Infinity;
    for (let index = 0; index < this.pending.length; index++) {
      const priority = this.pending[index]!.priority?.() ?? 0;
      if (best < 0 || priority < bestPriority) {
        best = index;
        bestPriority = priority;
      }
    }
    return best < 0 ? undefined : this.pending.splice(best, 1)[0];
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const work = this.next();
      if (!work) return;
      this.active += 1;
      void work.run().then(work.resolve, work.reject).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }
}
