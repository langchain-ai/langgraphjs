import { 
    QueueInterface,
    GET_OPTIONS,
    AbortError,
    Message,
    TimeoutError
} from "./types.mjs"
export class MemoryQueue implements QueueInterface {
  private log: Message[] = [];
  private listeners: ((idx: number) => void)[] = [];
  private queueId: string;

  private nextId = 0;
  private resumable = false;

  constructor(options: { resumable: boolean, queueId: string; }) {
    this.resumable = options.resumable;
    this.queueId = options.queueId;
  }

  async cleanup(): Promise<boolean> {
    this.listeners = [];
    this.log = [];
    this.nextId = 0;

    return Promise.resolve(true);
  }

  async push(item: Message): Promise<void> {
    this.log.push(item);
    for (const listener of this.listeners) listener(this.nextId);
    this.nextId += 1;
    return Promise.resolve();
  }

  async get(options: GET_OPTIONS): Promise<[string, Message]> {
    if (this.resumable) {
      const lastEventId = options.lastEventId;

      // Generator stores internal state of the read head index,
      let targetId = lastEventId != null ? +lastEventId + 1 : null;
      if (
        targetId == null ||
        isNaN(targetId) ||
        targetId < 0 ||
        targetId >= this.log.length
      ) {
        targetId = null;
      }

      if (targetId != null) return [String(targetId), this.log[targetId]];
    } else {
      if (this.log.length) {
        const nextId = this.nextId - this.log.length;
        const nextItem = this.log.shift()!;
        return [String(nextId), nextItem];
      }
    }

    let timeout: NodeJS.Timeout | undefined = undefined;
    let resolver: ((idx: number) => void) | undefined = undefined;

    const clean = new AbortController();

    // listen to new item
    return await new Promise<number>((resolve, reject) => {
      timeout = setTimeout(() => reject(new TimeoutError("Queue get operation timed out")), options.timeout);
      resolver = resolve;

      options.signal?.addEventListener(
        "abort",
        () => reject(new AbortError()),
        { signal: clean.signal },
      );

      this.listeners.push(resolver);
    })
      .then((idx) => {
        if (this.resumable) {
          return [String(idx), this.log[idx]] as [string, Message];
        }

        const nextId = this.nextId - this.log.length;
        const nextItem = this.log.shift()!;
        return [String(nextId), nextItem] as [string, Message];
      })
      .finally(() => {
        this.listeners = this.listeners.filter((l) => l !== resolver);
        clearTimeout(timeout);
        clean.abort();
      });
  }
}