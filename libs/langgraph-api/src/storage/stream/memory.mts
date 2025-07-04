import { Queue } from "../queue/index.mjs";
import { logger } from "../../logging.mjs";
import { 
    StreamManagerInterface,
    CancellationAbortController,
    ABORT_ACTION
} from "./types.mjs";

export class MemoryStreamManager implements StreamManagerInterface {
  readers: Record<string, Queue> = {};
  control: Record<string, CancellationAbortController> = {};
  private aborted: Set<string> = new Set();

  getQueue(
    runId: string,
    options: { ifNotFound: "create"; resumable: boolean },
  ): Queue {
    const queueKey = `${runId}:${options.resumable}`;
    
    if (this.readers[queueKey] == null) {
      this.readers[queueKey] = new Queue({
        resumable: options.resumable,
        queueId: runId
      });
    }

    return this.readers[queueKey];
  }

  async abort(runId: string, action: ABORT_ACTION): Promise<boolean> {
    if (this.control[runId] == null) return Promise.resolve(false);
    
    // Check if already aborted to prevent double-abort
    if (this.aborted.has(runId)) return Promise.resolve(false);

    const control: CancellationAbortController = this.control[runId];
    control.abort(action ?? "interrupt");
    this.aborted.add(runId);
    return Promise.resolve(true);
  }

  async isAborted(runId: string): Promise<boolean> {
    if (this.control[runId] == null) return Promise.resolve(false);
    return Promise.resolve(this.control[runId].signal.aborted);
  }

  async isLocked(runId: string): Promise<boolean> {
    return Promise.resolve(this.control[runId] != null);
  }

  async lock(runId: string): Promise<AbortSignal | null> {
    if (this.control[runId] != null) {
      logger.warn("Run already locked", { run_id: runId });
    }
    this.control[runId] = new CancellationAbortController();
    this.aborted.delete(runId); // Reset abort state when locking
    return Promise.resolve(this.control[runId].signal);
  }

  async unlock(runId: string): Promise<boolean> {
    delete this.control[runId];
    this.aborted.delete(runId);
    return Promise.resolve(true);
  }

  async cleanup(): Promise<boolean> {
    Object.keys(this.readers).forEach(key => { delete this.readers[key] });
    Object.keys(this.control).forEach(key => { this.unlock(key) });
    this.aborted.clear();

    return Promise.resolve(true);
  }
}