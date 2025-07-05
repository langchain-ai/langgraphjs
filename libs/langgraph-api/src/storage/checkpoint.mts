import { InMemorySaver } from "./checkpoint/memory.mjs";
import { PostgresSaver } from "./checkpoint/postgres.mjs";
import { storageConfig } from "./config.mjs";
import { pool } from "./connection/postgres.mjs";

let saver: InMemorySaver | PostgresSaver;

if (storageConfig.PERSISTENCE_TYPE === "memory") {
    saver = new InMemorySaver();
} else if (storageConfig.PERSISTENCE_TYPE === "postgres") {
    saver = new PostgresSaver(pool, undefined, { schema: storageConfig.POSTGRES_SCHEMA });
} else {
    throw new Error("Unsupported persistence type: " + storageConfig.PERSISTENCE_TYPE);
}

export const checkpointer = saver;