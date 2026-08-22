// Copyright (c) 2026, Oracle and/or its affiliates.
import {
  getOracleCheckpointTables,
  type OracleCheckpointTables,
} from "./sql.js";
import { oracleConstraintName } from "./utils.js";

export interface OracleCheckpointMigration {
  version: number;
  sql: string;
}

const getCreateMigrationTableSQL = (
  tables: OracleCheckpointTables
): string => `CREATE TABLE ${tables.checkpoint_migrations} (
  v NUMBER(10) NOT NULL,
  CONSTRAINT ${oracleConstraintName(
    tables.checkpoint_migrations,
    "pk"
  )} PRIMARY KEY (v)
)`;

const getCreateCheckpointsTableSQL = (
  tables: OracleCheckpointTables
): string => `CREATE TABLE ${tables.checkpoints} (
  thread_id VARCHAR2(2000) NOT NULL,
  checkpoint_ns VARCHAR2(2000) NOT NULL,
  checkpoint_id VARCHAR2(2000) NOT NULL,
  parent_checkpoint_id VARCHAR2(2000),
  type VARCHAR2(2000),
  checkpoint JSON NOT NULL,
  metadata JSON DEFAULT '{}' NOT NULL,
  CONSTRAINT ${oracleConstraintName(tables.checkpoints, "pk")} PRIMARY KEY (
    thread_id,
    checkpoint_ns,
    checkpoint_id
  )
)`;

const getCreateCheckpointBlobsTableSQL = (
  tables: OracleCheckpointTables
): string => `CREATE TABLE ${tables.checkpoint_blobs} (
  thread_id VARCHAR2(2000) NOT NULL,
  checkpoint_ns VARCHAR2(2000) NOT NULL,
  channel VARCHAR2(2000) NOT NULL,
  version VARCHAR2(2000) NOT NULL,
  type VARCHAR2(2000) NOT NULL,
  blob BLOB,
  CONSTRAINT ${oracleConstraintName(
    tables.checkpoint_blobs,
    "pk"
  )} PRIMARY KEY (
    thread_id,
    checkpoint_ns,
    channel,
    version
  )
)`;

const getCreateCheckpointWritesTableSQL = (
  tables: OracleCheckpointTables
): string => `CREATE TABLE ${tables.checkpoint_writes} (
  thread_id VARCHAR2(2000) NOT NULL,
  checkpoint_ns VARCHAR2(2000) NOT NULL,
  checkpoint_id VARCHAR2(2000) NOT NULL,
  task_id VARCHAR2(2000) NOT NULL,
  idx NUMBER(10) NOT NULL,
  channel VARCHAR2(2000) NOT NULL,
  type VARCHAR2(2000),
  blob BLOB NOT NULL,
  task_path VARCHAR2(2000) NOT NULL,
  CONSTRAINT ${oracleConstraintName(
    tables.checkpoint_writes,
    "pk"
  )} PRIMARY KEY (
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    task_id,
    idx
  )
)`;

const getCreateThreadIndexSQL = (
  tableName: string,
  indexName: string
): string => `CREATE INDEX ${indexName} ON ${tableName}(thread_id) ONLINE`;

/**
 * To add a new migration, append a new SQL string. The array index is the
 * migration version persisted in checkpoint_migrations.v.
 */
export const getMigrations = (tableSuffix: string = ""): string[] => {
  const tables = getOracleCheckpointTables(tableSuffix);
  return [
    getCreateMigrationTableSQL(tables),
    getCreateCheckpointsTableSQL(tables),
    getCreateCheckpointBlobsTableSQL(tables),
    getCreateCheckpointWritesTableSQL(tables),
    getCreateThreadIndexSQL(
      tables.checkpoints,
      oracleConstraintName(tables.checkpoints, "THREAD_ID_IDX")
    ),
    getCreateThreadIndexSQL(
      tables.checkpoint_blobs,
      oracleConstraintName(tables.checkpoint_blobs, "THREAD_ID_IDX")
    ),
    getCreateThreadIndexSQL(
      tables.checkpoint_writes,
      oracleConstraintName(tables.checkpoint_writes, "THREAD_ID_IDX")
    ),
  ];
};

export const getMigrationRecords = (
  tableSuffix: string = ""
): OracleCheckpointMigration[] =>
  getMigrations(tableSuffix).map((sql, version) => ({ version, sql }));
