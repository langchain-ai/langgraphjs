import {
  DEFAULT_TABLE_PREFIX,
  getOracleCheckpointTables,
  type OracleCheckpointTables,
} from "./sql.js";

export interface OracleCheckpointMigration {
  version: number;
  sql: string;
}

const constraintName = (tableName: string, suffix: string): string => {
  const maxPrefixLength = 128 - suffix.length - 1;
  return `${tableName.slice(0, maxPrefixLength)}_${suffix}`;
};

const getCreateMigrationTableSQL = (
  tables: OracleCheckpointTables
): string => `CREATE TABLE ${tables.checkpoint_migrations} (
  v NUMBER(10) NOT NULL,
  CONSTRAINT ${constraintName(tables.checkpoint_migrations, "pk")} PRIMARY KEY (v)
)`;

const getCreateCheckpointsTableSQL = (
  tables: OracleCheckpointTables
): string => `CREATE TABLE ${tables.checkpoints} (
  thread_id VARCHAR2(512) NOT NULL,
  checkpoint_ns VARCHAR2(512) NOT NULL,
  checkpoint_id VARCHAR2(512) NOT NULL,
  parent_checkpoint_id VARCHAR2(512),
  type VARCHAR2(255),
  metadata_type VARCHAR2(255),
  checkpoint BLOB NOT NULL,
  metadata BLOB NOT NULL,
  CONSTRAINT ${constraintName(tables.checkpoints, "pk")} PRIMARY KEY (
    thread_id,
    checkpoint_ns,
    checkpoint_id
  )
)`;

const getCreateCheckpointBlobsTableSQL = (
  tables: OracleCheckpointTables
): string => `CREATE TABLE ${tables.checkpoint_blobs} (
  thread_id VARCHAR2(512) NOT NULL,
  checkpoint_ns VARCHAR2(512) NOT NULL,
  channel VARCHAR2(512) NOT NULL,
  version VARCHAR2(512) NOT NULL,
  type VARCHAR2(255) NOT NULL,
  blob BLOB,
  CONSTRAINT ${constraintName(tables.checkpoint_blobs, "pk")} PRIMARY KEY (
    thread_id,
    checkpoint_ns,
    channel,
    version
  )
)`;

const getCreateCheckpointWritesTableSQL = (
  tables: OracleCheckpointTables
): string => `CREATE TABLE ${tables.checkpoint_writes} (
  thread_id VARCHAR2(512) NOT NULL,
  checkpoint_ns VARCHAR2(512) NOT NULL,
  checkpoint_id VARCHAR2(512) NOT NULL,
  task_id VARCHAR2(512) NOT NULL,
  idx NUMBER(10) NOT NULL,
  channel VARCHAR2(512) NOT NULL,
  type VARCHAR2(255),
  blob BLOB NOT NULL,
  CONSTRAINT ${constraintName(tables.checkpoint_writes, "pk")} PRIMARY KEY (
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    task_id,
    idx
  )
)`;

const getAddMetadataTypeSQL = (
  tables: OracleCheckpointTables
): string => `ALTER TABLE ${tables.checkpoints}
ADD metadata_type VARCHAR2(255)`;

/**
 * To add a new migration, append a new SQL string. The array index is the
 * migration version persisted in checkpoint_migrations.v.
 */
export const getMigrations = (
  tablePrefix: string = DEFAULT_TABLE_PREFIX
): string[] => {
  const tables = getOracleCheckpointTables(tablePrefix);
  return [
    getCreateMigrationTableSQL(tables),
    getCreateCheckpointsTableSQL(tables),
    getCreateCheckpointBlobsTableSQL(tables),
    getCreateCheckpointWritesTableSQL(tables),
    getAddMetadataTypeSQL(tables),
  ];
};

export const getMigrationRecords = (
  tablePrefix: string = DEFAULT_TABLE_PREFIX
): OracleCheckpointMigration[] =>
  getMigrations(tablePrefix).map((sql, version) => ({ version, sql }));
