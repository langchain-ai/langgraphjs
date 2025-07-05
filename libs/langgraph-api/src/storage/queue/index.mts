export * from "./types.mjs";
import { storageConfig } from "../config.mjs";
import { MemoryQueue } from "./memory.mjs";
import { RedisQueue } from "./redis.mjs";
import { QueueInterface, Message, GET_OPTIONS } from "./types.mjs";
export class Queue implements QueueInterface {
  private adapters: Record<string, QueueInterface> = {};
  private options: { resumable: boolean, queueId: string; };

  constructor(options: { resumable: boolean, queueId: string }) {
    this.options = options;
  }

  async push(item: Message): Promise<void> {
    const adapter = await this.adapter();
    return adapter.push(item);
  }

  async get(options: GET_OPTIONS): Promise<[id: string, message: Message]> {
    const adapter = await this.adapter();
    return adapter.get(options);
  }

  async cleanup(): Promise<boolean> {
    const adapter = await this.adapter();
    return adapter.cleanup();
  }

  private async adapter(): Promise<QueueInterface> {
    if (storageConfig.REDIS_URI_CUSTOM) {
      if (this.adapters.redis) return this.adapters.redis;


       this.adapters.redis = new RedisQueue(this.options)
      return Promise.resolve(this.adapters.redis);
    } else {
      if (this.adapters.memory) return this.adapters.memory; 

      this.adapters.memory = new MemoryQueue(this.options);
      return Promise.resolve(this.adapters.memory);
    }
  }
}