import { InMemoryStore } from "./store/memory.mjs";
import { PostgresStore } from "./store/postgres.mjs";
import { storageConfig } from "./config.mjs";

let _store: InMemoryStore | PostgresStore;

if (storageConfig.PERSISTENCE_TYPE === "memory") {
    _store = new InMemoryStore();
} else if (storageConfig.PERSISTENCE_TYPE === "postgres") {
    _store = new PostgresStore({
        connectionOptions: storageConfig.POSTGRES_URI_CUSTOM,
        schema: storageConfig.POSTGRES_SCHEMA
    });
} else {
    throw new Error("Unsupported persistence type: " + storageConfig.PERSISTENCE_TYPE);
}

export const store = _store;
