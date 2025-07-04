import { FileSystemPersistence } from "../persist.mjs";
import { PostgresPersistence } from "../persist/postgres.mjs";
import { 
    MemorySaver,
} from "@langchain/langgraph"

export type Connection = PostgresPersistence | FileSystemPersistence<{
    storage: typeof MemorySaver.prototype.storage;
    writes: typeof MemorySaver.prototype.writes;
}>;

export interface APISaver {
    initialize(cwd: string): Promise<APISaver>;
    clear(): Promise<void> | void;
    delete(threadId: string, runId: string | null | undefined): Promise<void>;
    copy(threadId: string, newThreadId: string): Promise<void> | void;
    flush(): Promise<boolean>;
}