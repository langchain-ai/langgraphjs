import * as pg from "pg";
import { Redis } from "ioredis";
import { Store } from "./types/store.mjs";
import { FileSystemPersistence } from "./persist.mjs";
import { PostgresPersistence } from "./persist/postgres.mjs";

export type PersistenceType = "memory" | "postgres"
export const PersistenceTypes = ["memory", "postgres"];
export type QueueType = "memory" | "redis";
export const QueueTypes = ["memory", "redis"]
export type Persistence = FileSystemPersistence<Store> | PostgresPersistence;

type StorageConfig = {
    PERSISTENCE_TYPE: PersistenceType;
    POSTGRES_URI_CUSTOM: string;
    LANGGRAPH_POSTGRES_POOL_MAX_SIZE: number;
    PERSISTENCE: Persistence | null;
    POSTGRES_SCHEMA: string;
    POSTGRES_POOL: pg.Pool | null
    REDIS_URI_CUSTOM?: string;
    REDIS_POOL: Redis | null;
    REDIS_BLOCKING_POOL: Redis | null; // Separate pool for blocking operations
    QUEUE_TYPE: QueueType;
};

export let storageConfig: StorageConfig = {
    PERSISTENCE_TYPE: "memory",
    POSTGRES_URI_CUSTOM: "",
    LANGGRAPH_POSTGRES_POOL_MAX_SIZE: 150,
    PERSISTENCE: null,
    POSTGRES_SCHEMA: "public",
    POSTGRES_POOL: null,
    REDIS_POOL: null,
    REDIS_BLOCKING_POOL: null,
    QUEUE_TYPE: "memory"
};

export const reload = async (): Promise<StorageConfig> => {
    storageConfig.PERSISTENCE_TYPE = (
        process.env.PERSISTENCE_TYPE ?? 
        (process.env.POSTGRES_URI_CUSTOM ? "postgres" : "memory")
    ) as PersistenceType;
    
    storageConfig.POSTGRES_URI_CUSTOM = process.env.POSTGRES_URI_CUSTOM ?? "";
    storageConfig.LANGGRAPH_POSTGRES_POOL_MAX_SIZE = Number.parseInt(
        process.env.LANGGRAPH_POSTGRES_POOL_MAX_SIZE ?? "150"
    );
    storageConfig.POSTGRES_SCHEMA = process.env.POSTGRES_SCHEMA ?? "public";
    storageConfig.REDIS_URI_CUSTOM = process.env.REDIS_URI_CUSTOM;
    storageConfig.QUEUE_TYPE = process.env.REDIS_URI_CUSTOM ? "redis" : "memory";
    
    if (storageConfig.PERSISTENCE_TYPE === "memory") {
        const conn = new FileSystemPersistence<Store>(
            ".langgraphjs_ops.json",
            () => ({
            runs: {},
            threads: {},
            assistants: {},
            assistant_versions: {},
            retry_counter: {},
            }),
        );
        await conn.initialize(".");
        storageConfig.PERSISTENCE = conn;
    } else if (storageConfig.PERSISTENCE_TYPE === "postgres") {
        const pool = new pg.Pool({
            connectionString: storageConfig.POSTGRES_URI_CUSTOM,
            max: storageConfig.LANGGRAPH_POSTGRES_POOL_MAX_SIZE,
        });
        const conn = new PostgresPersistence(pool);
        await conn.initialize();
        storageConfig.PERSISTENCE = conn;
        storageConfig.POSTGRES_POOL = pool;
    }
    
    return storageConfig;
};

await reload();

export const persistence = storageConfig.PERSISTENCE;