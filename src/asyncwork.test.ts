import { describe, expect, test } from "bun:test";

import { AsyncWorkQueue } from "./asyncwork";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("async work queue", () => {
  test("bounds concurrency and starts queued work in FIFO order", async () => {
    const queue = new AsyncWorkQueue(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    let running = 0;
    let peak = 0;

    const jobs = gates.map((gate, index) => queue.enqueue(async () => {
      started.push(index);
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
      return index;
    }));

    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(queue.activeCount).toBe(2);
    expect(queue.pendingCount).toBe(1);

    gates[0]!.resolve();
    await jobs[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    expect(peak).toBe(2);

    gates[1]!.resolve();
    gates[2]!.resolve();
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2]);
    expect(queue.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  test("continues after a rejected job", async () => {
    const queue = new AsyncWorkQueue(1);
    const first = queue.enqueue(async () => { throw new Error("nope"); });
    const second = queue.enqueue(async () => "ok");

    await expect(first).rejects.toThrow("nope");
    await expect(second).resolves.toBe("ok");
  });
  test("with priorities, the most wanted pending work starts first, judged when a slot frees", async () => {
    const queue = new AsyncWorkQueue(1);
    const gate = deferred();
    const started: string[] = [];
    const rank: Record<string, number> = { a: 5, b: 3, c: 9 };
    void queue.enqueue(async () => { started.push("first"); await gate.promise; });
    const jobs = ["a", "b", "c"].map((name) => queue.enqueue(async () => { started.push(name); }, () => rank[name]!));
    await Promise.resolve();
    // Priorities change while waiting (the view scrolled): c is now nearest.
    rank.c = 0;
    gate.resolve();
    await Promise.all(jobs);
    expect(started).toEqual(["first", "c", "b", "a"]);
  });
});
