import pg from "pg";
import { storageConfig } from "../config.mjs";

const { Pool } = pg;

export const pool = new Pool({
    connectionString: storageConfig.POSTGRES_URI_CUSTOM,
    max: storageConfig.LANGGRAPH_POSTGRES_POOL_MAX_SIZE
});