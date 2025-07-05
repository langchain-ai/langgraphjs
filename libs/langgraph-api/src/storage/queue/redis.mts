import { Redis } from "ioredis";
import { storageConfig } from "../config.mjs"
import { v4 as uuid4 } from "uuid";
import { serialize, deserialize } from "../persist/memory.mjs"
import { 
    QueueInterface,
    GET_OPTIONS,
    AbortError,
    Message,
    TimeoutError
} from "./types.mjs"

export class RedisQueue implements QueueInterface {
  private redis: Redis; 
  private redisUri: string; 
  private queueId: string;
  private queueKey: string;
  private resumable = false;

  constructor(options: { resumable: boolean, queueId: string }) {
    this.resumable = options.resumable;
    if (!storageConfig.REDIS_URI_CUSTOM) {
      throw new Error("REDIS_URI_CUSTOM must be set");
    }
    this.redis = new Redis(storageConfig.REDIS_URI_CUSTOM)
    this.redisUri = storageConfig.REDIS_URI_CUSTOM;

    this.queueId = options.queueId;
    this.queueKey = this.resumable ? `rsm-queue:${this.queueId}` : `fifo-queue:${this.queueId}`;
  }

  async cleanup(): Promise<boolean> {
    const result = await this.redis.del(this.queueKey);
    return result > 0;
  }

  async push(item: Message): Promise<void> {
    const serialized = serialize(item);

    if (this.resumable) {
        await this.redis.xadd(this.queueKey, "*", "message", serialized);
    } else {
        await this.redis.lpush(this.queueKey, serialized);
    }
  }

  async get(options: GET_OPTIONS): Promise<[id: string, message: Message]> {
    // Create a dedicated client for this single blocking operation
    const blocker = new Redis(this.redisUri, {
      // Prevent ioredis from trying to reconnect after we forcefully disconnect it
      maxRetriesPerRequest: 0,
    });

    const abortHandler = () => {
      // The sole job of the abort handler is to trigger the cancellation
      // by disconnecting the client. This will cause the pending 
      // `xread` or `brpop` command to reject.
      blocker.disconnect();
    };

    // If a signal is provided, attach our handler.
    options.signal?.addEventListener("abort", abortHandler);

    // Handle the edge case where the operation is aborted before it even starts.
    if (options.signal?.aborted) {
      blocker.disconnect(); // Clean up the created client
      options.signal?.removeEventListener("abort", abortHandler); // Clean up listener
      throw new AbortError();
    }
    
    try {
      // We no longer need Promise.race. We await the Redis command directly.
      const redisPromise = this.resumable
        ? this.getFromStream(blocker, options)
        : this.getFromList(blocker, options);
      
      return await redisPromise;

    } catch (error: any) {
      // After the command rejects, we check *why*.
      // If the signal was aborted, we know our handler caused the rejection.
      // In this case, we throw the semantically correct AbortError.
      if (options.signal?.aborted) {
        throw new AbortError();
      }
      
      // If the signal was not aborted, it means the error was a genuine
      // timeout or another Redis error. We re-throw it as is.
      throw error;

    } finally {
      // CRITICAL: This block executes regardless of success, timeout, or abort.
      // Always clean up the listener and the dedicated connection.
      options.signal?.removeEventListener("abort", abortHandler);
      blocker.disconnect();
    }
  }

  private async getFromStream(blocker: Redis, options: GET_OPTIONS): Promise<[id: string, message: Message]> {
    let startId: string;
    if (options.lastEventId == null) {
      startId = "$";
    } else if (options.lastEventId === "-1") {
      startId = "0-0";
    } else {
      const isValidRedisStreamId = /^(\d+-\d+|\$|>|0-0)$/.test(options.lastEventId);
      startId = isValidRedisStreamId ? options.lastEventId : "$";
    }
    
    const response = await blocker.xread(
      "BLOCK",
      options.timeout,
      "STREAMS",
      this.queueKey,
      startId
    );

    if (response === null) {
      throw new TimeoutError("Queue get operation timed out");
    }

    const [, messages] = response[0];
    const [redisId, fields] = messages[0];
    const messageData = await deserialize(fields[1]) as Message;

    return [redisId, messageData];
  }

  private async getFromList(blocker: Redis, options: GET_OPTIONS): Promise<[id: string, message: Message]> {
    const timeoutInSeconds = Math.ceil(options.timeout / 1000);

    const response = await blocker.brpop(this.queueKey, timeoutInSeconds);

    if (response === null) {
      throw new TimeoutError("Queue get operation timed out");
    }

    const [, serialized] = response;
    const messageData: any = await deserialize(serialized);
    const id = String(Date.now()); 

    return [id, messageData];
  }
}
