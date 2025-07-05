import { PostgresSaver as CorePostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { APISaver } from "./types.mjs";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  type Checkpoint,
  type CheckpointMetadata,
} from "@langchain/langgraph";

const TABLES = [
    "checkpoints",
    "checkpoint_blobs",
    "checkpoint_writes",
    "checkpoint_migrations"
]

const EXCLUDED_KEYS = ["checkpoint_ns", "checkpoint_id", "run_id", "thread_id"];

// API-specific migrations that extend the core LangGraph schema
const API_MIGRATIONS = [
    // Migration 0: Add run_id column to checkpoints
    `ALTER TABLE {schema}.checkpoints ADD COLUMN IF NOT EXISTS run_id UUID`,
    // Migration 1: Add checkpoint_id column to checkpoint_blobs  
    `ALTER TABLE {schema}.checkpoint_blobs ADD COLUMN IF NOT EXISTS checkpoint_id UUID`
];

export class PostgresSaver extends CorePostgresSaver implements APISaver {
    async initialize(cwd: string): Promise<PostgresSaver> {
        await this.setup();
        await this.runApiMigrations();
        return this;
    }

    private async runApiMigrations(): Promise<void> {
        // @ts-ignore - We have access to pool.connect
        const client = await this.pool.connect();
        
        try {
            // @ts-ignore - We have access to options.schema
            const schema = this.options.schema;
            
            // Create API migrations table if it doesn't exist
            await client.query(`
                CREATE TABLE IF NOT EXISTS ${schema}.api_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Check current API migration version
            let currentVersion = -1;
            try {
                const result = await client.query(`
                    SELECT version FROM ${schema}.api_migrations 
                    ORDER BY version DESC LIMIT 1
                `);
                if (result.rows.length > 0) {
                    currentVersion = result.rows[0].version;
                }
            } catch (error: any) {
                // Table might not exist yet, continue with version -1
                console.log("API migrations table not found, starting fresh");
            }
            
            // Apply pending migrations
            for (let version = currentVersion + 1; version < API_MIGRATIONS.length; version++) {
                const migration = API_MIGRATIONS[version].replace('{schema}', schema);
                console.log(`Applying API migration ${version}: ${migration.substring(0, 80)}...`);
                
                await client.query(migration);
                await client.query(`
                    INSERT INTO ${schema}.api_migrations (version) VALUES ($1)
                `, [version]);
                
                console.log(`✅ API migration ${version} applied successfully`);
            }
            
        } catch (error) {
            console.error("Error running API migrations:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    async clear(): Promise<void> {
        // @ts-ignore - We have access to pool.connect
        const client = await this.pool.connect();
        const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';");
        const existingTables = res.rows.map((t: any) => t.table_name)
        const tables = existingTables.filter((t: string) => TABLES.includes(t))
        // @ts-ignore - We have access to options.schema
        const truncateStatements = tables.map((t: string) => `TRUNCATE TABLE ${this.options.schema}.${t}`)
        await client.query(`
            BEGIN;
            ${truncateStatements.join(";\n")};
            COMMIT;
        `);
        
        client.release();
    }

    async copy(threadId: string, newThreadId: string): Promise<void> {
        // @ts-ignore - We have access to pool.connect
        const client = await this.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // @ts-ignore - We have access to options.schema
            const schema = this.options.schema;
            
            // Copy checkpoints - now assuming run_id column exists after migrations
            await client.query(`
                INSERT INTO ${schema}.checkpoints (
                    thread_id, checkpoint_id, run_id, parent_checkpoint_id, 
                    checkpoint, metadata, checkpoint_ns
                )
                SELECT 
                    $2 as thread_id,
                    checkpoint_id,
                    run_id,
                    parent_checkpoint_id,
                    checkpoint,
                    metadata,
                    checkpoint_ns
                FROM ${schema}.checkpoints 
                WHERE thread_id = $1
            `, [threadId, newThreadId]);
            
            // Copy checkpoint_blobs
            await client.query(`
                INSERT INTO ${schema}.checkpoint_blobs (
                    thread_id, checkpoint_id, channel, version, type, blob, checkpoint_ns
                )
                SELECT 
                    $2 as thread_id,
                    checkpoint_id,
                    channel,
                    version,
                    type,
                    blob,
                    checkpoint_ns
                FROM ${schema}.checkpoint_blobs 
                WHERE thread_id = $1
            `, [threadId, newThreadId]);
            
            // Copy checkpoint_writes
            await client.query(`
                INSERT INTO ${schema}.checkpoint_writes (
                    thread_id, checkpoint_id, task_id, idx, channel, type, blob, checkpoint_ns
                )
                SELECT 
                    $2 as thread_id,
                    checkpoint_id,
                    task_id,
                    idx,
                    channel,
                    type,
                    blob,
                    checkpoint_ns
                FROM ${schema}.checkpoint_writes 
                WHERE thread_id = $1
            `, [threadId, newThreadId]);
            
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async delete(threadId: string, runId: string | null | undefined): Promise<void> {
        // @ts-ignore - We have access to pool.connect
        const client = await this.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // @ts-ignore - We have access to options.schema
            const schema = this.options.schema;
            
            if (runId != null) {
                // Delete specific run's data
                await client.query(`DELETE FROM ${schema}.checkpoint_writes WHERE thread_id = $1 AND checkpoint_id IN (
                    SELECT checkpoint_id FROM ${schema}.checkpoints WHERE thread_id = $1 AND run_id = $2
                )`, [threadId, runId]);
                
                await client.query(`DELETE FROM ${schema}.checkpoint_blobs WHERE thread_id = $1 AND checkpoint_id IN (
                    SELECT checkpoint_id FROM ${schema}.checkpoints WHERE thread_id = $1 AND run_id = $2
                )`, [threadId, runId]);
                
                await client.query(`DELETE FROM ${schema}.checkpoints WHERE thread_id = $1 AND run_id = $2`, [threadId, runId]);
            } else {
                // Delete all data for the thread
                await client.query(`DELETE FROM ${schema}.checkpoint_writes WHERE thread_id = $1`, [threadId]);
                await client.query(`DELETE FROM ${schema}.checkpoint_blobs WHERE thread_id = $1`, [threadId]);
                await client.query(`DELETE FROM ${schema}.checkpoints WHERE thread_id = $1`, [threadId]);
            }
            
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
    ): Promise<RunnableConfig> {
        // Merge config.metadata with checkpoint metadata, similar to InMemorySaver
        const mergedMetadata = {
            ...Object.fromEntries(
                Object.entries(config.configurable ?? {}).filter(
                    ([key]) => !key.startsWith("__") && !EXCLUDED_KEYS.includes(key),
                ),
            ),
            ...config.metadata,
            ...metadata,
        };

        return await super.put(config, checkpoint, mergedMetadata, {});
    }

    toJSON() {
        return "[PostgresSaver]";
    }
}