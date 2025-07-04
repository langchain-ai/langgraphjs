import { Queue } from "../queue/index.mjs";
import { MemoryStreamManager } from "./memory.mjs";
import { RedisStreamManager } from "./redis.mjs";
import { storageConfig } from "../config.mjs";
import { 
    StreamManagerInterface,
    ABORT_ACTION
} from "./types.mjs";

export class StreamManagerAdapter implements StreamManagerInterface {
  private adapters: Record<string, StreamManagerInterface> = {};

  getQueue(
    runId: string,
    options: { ifNotFound: "create"; resumable: boolean },
  ): Queue {
    const adapter = this.adapter();
    return adapter.getQueue(runId, {
      ifNotFound: options.ifNotFound,
      resumable: options.resumable
    });
  }

  async isLocked(runId: string): Promise<boolean> {
    const adapter = this.adapter();
    return adapter.isLocked(runId);
  }

  async lock(runId: string): Promise<AbortSignal | null> {
    const adapter = this.adapter();
    return adapter.lock(runId);
  }

  unlock(runId: string) {
    const adapter = this.adapter();
    return adapter.unlock(runId);
  }

  async cleanup(): Promise<boolean> {
    const adapter = this.adapter();
    return adapter.cleanup();
  }

  async abort(runId: string, action: ABORT_ACTION): Promise<boolean> {
    const adapter = this.adapter();
    return adapter.abort(runId, action);
  }

  async isAborted(runId: string): Promise<boolean> {
    const adapter = this.adapter();
    return adapter.isAborted(runId);
  }

  private adapter(): StreamManagerInterface {
    if (storageConfig.REDIS_URI_CUSTOM) {
      if (this.adapters.redis) return this.adapters.redis;

       this.adapters.redis = new RedisStreamManager()
      return this.adapters.redis;
    } else {
      if (this.adapters.memory) return this.adapters.memory; 

      this.adapters.memory = new MemoryStreamManager();
      return this.adapters.memory;
    }
  }
}

export const StreamManager = new StreamManagerAdapter();