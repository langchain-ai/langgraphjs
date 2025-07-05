import { PostgresStore as BasePostgresStore } from "@langchain/langgraph-store-postgres";
import { Store } from "./types.mjs";

export class PostgresStore extends BasePostgresStore implements Store {
    async initialize(cwd: string): Promise<Store> {
        await this.setup();
        return this;
    }

    async flush(): Promise<boolean> {
        return true;
    }
}