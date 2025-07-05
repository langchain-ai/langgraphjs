import { Queue } from "../queue/index.mjs";

export type ABORT_ACTION = "interrupt" | "rollback";
export class CancellationAbortController extends AbortController {
  abort(reason: ABORT_ACTION) {
    super.abort(reason);
  }
}

export type GET_QUEUE_OPTIONS = {
    runId: string;
    options: {
        ifNotFound: string;
        resumable: boolean;
    }
}

export interface StreamManagerInterface {
  getQueue(runId: string, options: { 
    ifNotFound: string, 
    resumable: boolean 
  }): Queue;
  abort(runId: string, action: ABORT_ACTION): Promise<boolean>;
  isAborted(runId: string): Promise<boolean>;
  isLocked(runId: string): Promise<boolean>;
  lock(runId: string): Promise<AbortSignal | null>;
  unlock(runId: string): Promise<boolean>;
  cleanup(): Promise<boolean>;
}