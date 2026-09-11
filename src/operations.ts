import { AsyncLocalStorage } from "node:async_hooks";

type Operation = {
  pending: Set<Promise<unknown>>;
  cancelled: boolean;
  done: boolean;
  finished: Promise<void>;
};
export class OperationCancelled extends Error {
  constructor() {
    super("Pi operation cancelled");
  }
}

/** Own native calls, including calls started by their extension callbacks. */
export class Operations {
  constructor(private readonly background?: (event: "start" | "end") => void) {}
  private readonly context = new AsyncLocalStorage<Operation>();
  private active?: Operation;
  private readonly waiting = new Set<{ cancelled: boolean }>();

  get cancelled(): boolean {
    return (
      this.context.getStore()?.cancelled ?? this.active?.cancelled ?? false
    );
  }

  enter<T>(action: () => Promise<T>): Promise<T> {
    const inherited = this.context.getStore();
    return inherited && !inherited.done ? this.call(action) : this.run(action);
  }

  /** Native callbacks join a live operation; later background calls start another. */
  call<T>(action: () => Promise<T>): Promise<T> {
    const inherited = this.context.getStore();
    if (inherited?.cancelled) return Promise.reject(new OperationCancelled());
    const operation = inherited && !inherited.done ? inherited : this.active;
    if (!operation) return this.run(action, true);
    if (operation.cancelled) return Promise.reject(new OperationCancelled());
    return this.track(operation, action);
  }

  /** A host request cannot overtake accepted native/background work. */
  async run<T>(action: () => Promise<T>, background = false): Promise<T> {
    const waiting = { cancelled: false };
    this.waiting.add(waiting);
    try {
      while (this.active) await this.active.finished;
      if (waiting.cancelled) throw new OperationCancelled();
    } finally {
      this.waiting.delete(waiting);
    }
    let finish!: () => void;
    const operation: Operation = {
      pending: new Set(),
      cancelled: false,
      done: false,
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.active = operation;
    try {
      if (background) this.background?.("start");
      return await this.track(operation, action);
    } finally {
      while (operation.pending.size)
        await Promise.allSettled([...operation.pending]);
      operation.done = true;
      if (this.active === operation) this.active = undefined;
      finish();
      if (background) this.background?.("end");
    }
  }

  private track<T>(operation: Operation, action: () => Promise<T>): Promise<T> {
    const work = this.context.run(operation, async () => action());
    operation.pending.add(work);
    void work.then(
      () => operation.pending.delete(work),
      () => operation.pending.delete(work),
    );
    return work;
  }

  async cancel(abort: () => Promise<void>): Promise<void> {
    const operation = this.active;
    if (operation) operation.cancelled = true;
    for (const waiting of this.waiting) waiting.cancelled = true;
    await abort();
    // abort() alone does not wait for preflight, commands or extension callbacks.
    await operation?.finished;
  }
}
