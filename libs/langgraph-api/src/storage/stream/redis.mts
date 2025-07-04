import { Redis } from "ioredis";
import { storageConfig } from "../config.mjs"
import { Queue } from "../queue/index.mjs";
import { logger } from "../../logging.mjs";
import { 
    StreamManagerInterface,
    CancellationAbortController,
    ABORT_ACTION
} from "./types.mjs";

const lockKey = (runId: string) => `lock:run:${runId}`;
const LOCK_LEASE_TIME_MS = 30000; // 30 seconds

export class RedisStreamManager implements StreamManagerInterface {
  control: Record<string, CancellationAbortController> = {};
  private redis: Redis;
  private subscriber: Redis;

  constructor() {
    if (!storageConfig.REDIS_URI_CUSTOM) {
        throw new Error("Redis not initialized for StreamManager.");
    }
    this.redis = new Redis(storageConfig.REDIS_URI_CUSTOM)
    this.subscriber = new Redis(storageConfig.REDIS_URI_CUSTOM)
    this.setupCancellationListener();
  }

  getQueue(
    runId: string,
    options: { ifNotFound: "create"; resumable: boolean },
  ): Queue {
    return new Queue({ ...options, queueId: runId });
  }

  async abort(runId: string, action: ABORT_ACTION): Promise<boolean> {
    if (!await this.isLocked(runId)) return false;

    // Check if already aborted using Redis
    const abortKey = `abort:run:${runId}`;
    const isAborted = await this.redis.get(abortKey);
    
    if (isAborted) {
      return false; // Already aborted
    }

    // Set abort state atomically
    const result = await this.redis.set(abortKey, action, "NX");
    if (result === null) {
      return false; // Another process aborted first
    }

    // Publish the abort message
    await this.redis.publish("run:cancel", JSON.stringify({ runId, action }));
    return true;
  }

  async isAborted(runId: string): Promise<boolean> {
    const abortKey = `abort:run:${runId}`;
    const result = await this.redis.get(abortKey);
    return result !== null;
  }

  async isLocked(runId: string): Promise<boolean> {
    const result = await this.redis.exists(lockKey(runId));
    return result === 1;
  }

  async lock(runId: string): Promise<AbortSignal | null> {
    // Try to acquire the lock atomically with a lease time.
    const result = await this.redis.set(
      lockKey(runId),
      "locked",      // The value doesn't matter much
      "PX",          // Millisecond precision for expiry
      LOCK_LEASE_TIME_MS,
      "NX"           // Set only if the key does not exist
    );

    if (result === "OK") {
      // Lock acquired successfully!
      this.control[runId] = new CancellationAbortController();
      // Start a heartbeat to extend the lock lease while the task is running.
      this.startLockHeartbeat(runId);
      return this.control[runId].signal;
    } else {
      // Failed to acquire lock, it's held by another process.
      return null;
    }
  }

  async unlock(runId: string): Promise<boolean> {
    // Remove the local controller first to stop the heartbeat
    delete this.control[runId];
    // Delete both the lock and abort keys from Redis
    await this.redis.del(lockKey(runId), `abort:run:${runId}`);
    return true;
  }

  async cleanup(): Promise<boolean> {
    Object.keys(this.control).forEach(key => { this.unlock(key) });

    return Promise.resolve(true);
  }

  // Heartbeat to keep the lock alive for long-running tasks
  private startLockHeartbeat(runId: string) {
      const interval = setInterval(() => {
        if (this.control[runId]) {
            // Refresh the lock's TTL
            this.redis.pexpire(lockKey(runId), LOCK_LEASE_TIME_MS);
        } else {
            // The run has been unlocked, stop the heartbeat
            clearInterval(interval);
        }
    }, LOCK_LEASE_TIME_MS / 2); // Refresh halfway through the lease
  }

  private setupCancellationListener() {
    // Listen for cancellation messages broadcast across all servers
    this.subscriber.subscribe("run:cancel", (err) => {
      if (err) {
        logger.error("Failed to subscribe to run:cancel channel", { error: err });
      }
    });

    this.subscriber.on("message", (channel, message) => {
      if (channel === "run:cancel") {
        try {
          const { runId, action } = JSON.parse(message);
          const controller: CancellationAbortController = this.control[runId];
          if (controller) {
            controller.abort(action);
          }
        } catch (e) {
            logger.error("Failed to parse cancellation message", { message, error: e });
        }
      }
    });
  }

}