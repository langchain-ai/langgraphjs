import * as pg from "pg";

interface PostgresPersistenceOptions {
  schema: string;
}

const _defaultOptions: PostgresPersistenceOptions = {
  schema: "public",
};

const _ensureCompleteOptions = (
  options?: Partial<PostgresPersistenceOptions>
): PostgresPersistenceOptions => {
  return {
    ...options,
    schema: options?.schema ?? _defaultOptions.schema,
  };
};

export const SCHEMA_TABLES = {
  schema_migrations: "schema_migrations",
  assistants: "assistant",
  assistant_versions: "assistant_versions",
  runs: "run",
  threads: "thread",
  retry_counter: "retry_counter",
}

export const SCHEMAS = {}

const getMigrations = (schema: string) => {
  return [
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.schema_migrations} (
    v INTEGER PRIMARY KEY
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.assistants} (
      assistant_id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY CONSTRAINT unique_assistant_id UNIQUE,
      graph_id text NOT NULL,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now(),
      config jsonb DEFAULT '{}'::jsonb NOT NULL,
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      name text,
      description text
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.assistant_versions} (
      assistant_version_id uuid NOT NULL PRIMARY KEY CONSTRAINT unique_assistant_version_id UNIQUE,
      assistant_id uuid NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      graph_id text NOT NULL,
      config jsonb DEFAULT '{}'::jsonb NOT NULL,
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      created_at timestamp with time zone DEFAULT now(),
      name text
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.runs} (
      run_id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY CONSTRAINT unique_run_id UNIQUE,
      thread_id uuid NOT NULL ,
      assistant_id uuid NOT NULL,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now(),
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      status text DEFAULT 'pending'::text NOT NULL,
      kwargs jsonb NOT NULL,
      multitask_strategy text DEFAULT 'reject'::text NOT NULL
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.threads} (
      thread_id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY CONSTRAINT unique_thread_id UNIQUE,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now(),
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      status text DEFAULT 'idle'::text NOT NULL,
      config jsonb DEFAULT '{}'::jsonb NOT NULL,
      "values" jsonb,
      interrupts jsonb DEFAULT '{}'::jsonb
  );`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLES.retry_counter} (
      run_id uuid NOT NULL PRIMARY KEY CONSTRAINT retry_unique_run_id UNIQUE,
      created_at timestamp with time zone DEFAULT now(),
      updated_at timestamp with time zone DEFAULT now(),
      counter integer DEFAULT 0
  );`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS assistant_versions_assistant_id_version_idx ON ${SCHEMA_TABLES.assistant_versions} (assistant_id, version);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistants_graph_id ON ${SCHEMA_TABLES.assistants} (graph_id);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistants_created_at ON ${SCHEMA_TABLES.assistants} (created_at);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistants_updated_at ON ${SCHEMA_TABLES.assistants} (updated_at);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistants_name ON ${SCHEMA_TABLES.assistants} (name);`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_versions_assistant_id ON ${SCHEMA_TABLES.assistant_versions} (assistant_id);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_versions_graph_id ON ${SCHEMA_TABLES.assistant_versions} (graph_id);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_versions_created_at ON ${SCHEMA_TABLES.assistant_versions} (created_at);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_versions_version ON ${SCHEMA_TABLES.assistant_versions} (version);`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_thread_id ON ${SCHEMA_TABLES.runs} (thread_id);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_assistant_id ON ${SCHEMA_TABLES.runs} (assistant_id);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_created_at ON ${SCHEMA_TABLES.runs} (created_at);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_updated_at ON ${SCHEMA_TABLES.runs} (updated_at);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_status ON ${SCHEMA_TABLES.runs} (status);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_thread_assistant ON ${SCHEMA_TABLES.runs} (thread_id, assistant_id);`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_created_at ON ${SCHEMA_TABLES.threads} (created_at);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_updated_at ON ${SCHEMA_TABLES.threads} (updated_at);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_status ON ${SCHEMA_TABLES.threads} (status);`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_retry_counter_created_at ON ${SCHEMA_TABLES.retry_counter} (created_at);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_retry_counter_updated_at ON ${SCHEMA_TABLES.retry_counter} (updated_at);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_retry_counter_counter ON ${SCHEMA_TABLES.retry_counter} (counter);`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_versions_assistant_id_fk ON ${SCHEMA_TABLES.assistant_versions} (assistant_id);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_thread_id_fk ON ${SCHEMA_TABLES.runs} (thread_id);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_assistant_id_fk ON ${SCHEMA_TABLES.runs} (assistant_id);`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_status_created_at ON ${SCHEMA_TABLES.runs} (status, created_at);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_status_updated_at ON ${SCHEMA_TABLES.threads} (status, updated_at);`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistants_metadata_gin ON ${SCHEMA_TABLES.assistants} USING gin (metadata);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_versions_metadata_gin ON ${SCHEMA_TABLES.assistant_versions} USING gin (metadata);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_metadata_gin ON ${SCHEMA_TABLES.runs} USING gin (metadata);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_metadata_gin ON ${SCHEMA_TABLES.threads} USING gin (metadata);`,

  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistants_config_gin ON ${SCHEMA_TABLES.assistants} USING gin (config);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_versions_config_gin ON ${SCHEMA_TABLES.assistant_versions} USING gin (config);`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_config_gin ON ${SCHEMA_TABLES.threads} USING gin (config);`,
  ];
};

/**
 * LangGraph checkpointer that uses a Postgres instance as the backing store.
 * Uses the [node-postgres](https://node-postgres.com/) package internally
 * to connect to a Postgres instance.
 *
 * @example
 * ```
 * import { ChatOpenAI } from "@langchain/openai";
 * import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
 * import { createReactAgent } from "@langchain/langgraph/prebuilt";
 *
 * const checkpointer = PostgresSaver.fromConnString(
 *   "postgresql://user:password@localhost:5432/db",
 *   // optional configuration object
 *   {
 *     schema: "custom_schema" // defaults to "public"
 *   }
 * );
 *
 * // NOTE: you need to call .setup() the first time you're using your checkpointer
 * await checkpointer.setup();
 *
 * const graph = createReactAgent({
 *   tools: [getWeather],
 *   llm: new ChatOpenAI({
 *     model: "gpt-4o-mini",
 *   }),
 *   checkpointSaver: checkpointer,
 * });
 * const config = { configurable: { thread_id: "1" } };
 *
 * await graph.invoke({
 *   messages: [{
 *     role: "user",
 *     content: "what's the weather in sf"
 *   }],
 * }, config);
 * ```
 */
export class PostgresPersistence {
  readonly pool: pg.Pool;
  private readonly options: PostgresPersistenceOptions;
  protected isSetup: boolean;

  constructor(
    pool: pg.Pool,
    options?: Partial<PostgresPersistenceOptions>
  ) {
    this.pool = pool;
    this.isSetup = false;
    this.options = _ensureCompleteOptions(options);
  }

  /**
   * Set up the database asynchronously.
   *
   * This method creates the necessary tables in the Postgres database if they don't
   * already exist and runs database migrations. It MUST be called directly by the user
   * the first time server is used.
   */
  async initialize(): Promise<PostgresPersistence> {
    const client = await this.pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.options.schema}`);
      let version = -1;
      const MIGRATIONS = getMigrations(this.options.schema);

      try {
        const result = await client.query(
          `SELECT v FROM ${SCHEMA_TABLES.schema_migrations} ORDER BY v DESC LIMIT 1`
        );
        if (result.rows.length > 0) {
          version = result.rows[0].v;
        }
      } catch (error: unknown) {
        // Assume table doesn't exist if there's an error
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string" &&
          error.code === "42P01" // Postgres error code for undefined_table
        ) {
          version = -1;
        } else {
          throw error;
        }
      }

      for (let v = version + 1; v < MIGRATIONS.length; v += 1) {
        await client.query(MIGRATIONS[v]);
        await client.query(
          `INSERT INTO ${SCHEMA_TABLES.schema_migrations} (v) VALUES ($1)`,
          [v]
        );
      }
    } finally {
      client.release();
    }

    return this;
  }

  async with<T>(fn: (client: pg.PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}