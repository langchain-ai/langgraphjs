// Copyright (c) 2026, Oracle and/or its affiliates.
import { oracleConstraintName } from "../utils.js";
import { generatedIdentifier } from "../identifiers.js";
import {
  createConfiguredVectorIndexSQL,
  type OracleIndexConfig,
} from "./index-config.js";

export interface OracleStoreMigrationTables {
  store: string;
  storeVectors: string;
  storeMigrations: string;
  vectorMigrations: string;
}

export interface OracleStoreMigrationContext {
  tables: OracleStoreMigrationTables;
  index?: OracleIndexConfig;
}

/**
 * One versioned schema statement.
 *
 * The array index is the version recorded in the migration table, matching
 * Python's `MIGRATIONS` / `VECTOR_MIGRATIONS` and the checkpoint saver's
 * `getMigrations()`.
 */
export interface OracleStoreMigration {
  sql: (context: OracleStoreMigrationContext) => string;
  /** Skip this version when the condition is not met. */
  condition?: (context: OracleStoreMigrationContext) => boolean;
}

export const getCreateStoreMigrationTableSQL = (
  tables: OracleStoreMigrationTables
): string => `CREATE TABLE ${tables.storeMigrations} (
  v NUMBER(10) NOT NULL,
  CONSTRAINT ${oracleConstraintName(
    tables.storeMigrations,
    "PK"
  )} PRIMARY KEY (v)
)`;

export const getCreateVectorMigrationTableSQL = (
  tables: OracleStoreMigrationTables
): string => `CREATE TABLE ${tables.vectorMigrations} (
  v NUMBER(10) NOT NULL,
  CONSTRAINT ${oracleConstraintName(
    tables.vectorMigrations,
    "PK"
  )} PRIMARY KEY (v)
)`;

export const getCreateStoreTableSQL = (
  tables: OracleStoreMigrationTables
): string => `CREATE TABLE ${tables.store} (
  prefix VARCHAR2(4000) NOT NULL,
  key VARCHAR2(4000) NOT NULL,
  value JSON NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  ttl_minutes NUMBER DEFAULT NULL,
  CONSTRAINT ${oracleConstraintName(
    tables.store,
    "PK"
  )} PRIMARY KEY (prefix, key)
)`;

export const getCreateStoreVectorTableSQL = (
  tables: OracleStoreMigrationTables,
  dims: number
): string => `CREATE TABLE ${tables.storeVectors} (
  prefix VARCHAR2(2000) NOT NULL,
  key VARCHAR2(2000) NOT NULL,
  field_name VARCHAR2(2000) NOT NULL,
  embedding VECTOR(${dims}),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ${oracleConstraintName(tables.storeVectors, "PK")} PRIMARY KEY (
    prefix,
    key,
    field_name
  ),
  CONSTRAINT ${oracleConstraintName(tables.storeVectors, "FK")} FOREIGN KEY (
    prefix,
    key
  ) REFERENCES ${tables.store}(prefix, key) ON DELETE CASCADE
)`;

function requireIndexConfig(
  context: OracleStoreMigrationContext
): OracleIndexConfig {
  if (!context.index) {
    throw new Error(
      "OracleStore vector migrations require an index configuration."
    );
  }
  return context.index;
}

/**
 * Store schema, one entry per version. Mirrors Python's `MIGRATIONS`; do not
 * reorder or remove entries, only append.
 */
export const STORE_MIGRATIONS: OracleStoreMigration[] = [
  { sql: ({ tables }) => getCreateStoreTableSQL(tables) },
  {
    sql: ({ tables }) =>
      `CREATE INDEX ${generatedIdentifier(
        `${tables.store}_PREFIX_IDX`
      )} ON ${tables.store} (prefix) ONLINE`,
  },
  {
    sql: ({ tables }) =>
      `CREATE INDEX ${generatedIdentifier(
        `IDX_${tables.store}_EXPIRES_AT`
      )} ON ${tables.store} (expires_at) ONLINE`,
  },
  {
    sql: () => `CREATE TABLE STORE_CONFIGS (
  table_suffix VARCHAR2(4000) PRIMARY KEY,
  detected_dims NUMBER NOT NULL,
  distance_type VARCHAR2(4000) DEFAULT 'COSINE',
  index_params JSON,
  embed_fields VARCHAR2(4000),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`,
  },
  {
    sql: () =>
      "CREATE INDEX IDX_STORE_CONFIGS_TABLE_SUFFIX ON STORE_CONFIGS(table_suffix) ONLINE",
  },
];

/**
 * Vector schema, one entry per version. Mirrors Python's `VECTOR_MIGRATIONS`,
 * including the vector index as version 1.
 */
export const VECTOR_MIGRATIONS: OracleStoreMigration[] = [
  {
    sql: (context) =>
      getCreateStoreVectorTableSQL(
        context.tables,
        requireIndexConfig(context).dims
      ),
  },
  {
    condition: (context) => context.index !== undefined,
    sql: (context) =>
      createConfiguredVectorIndexSQL(
        context.tables.storeVectors,
        requireIndexConfig(context)
      ),
  },
];
