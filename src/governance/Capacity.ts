// FIFO permits shared by all executions in one process.
export class Capacity {
  private active = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.limit) return this.take();

    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", abort);
        resolve(this.take());
      };
      const abort = () => {
        this.waiters.delete(grant);
        reject(signal.reason);
      };
      this.waiters.add(grant);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private take(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.values().next().value;
      if (next) {
        this.waiters.delete(next);
        next();
      }
    };
  }
}
