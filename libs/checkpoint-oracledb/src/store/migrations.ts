// Copyright (c) 2026, Oracle and/or its affiliates.
import { oracleConstraintName } from "../utils.js";

export interface OracleStoreMigrationTables {
  store: string;
  storeVectors: string;
  storeMigrations: string;
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

export const getCreateStoreTableSQL = (
  tables: OracleStoreMigrationTables
): string => `CREATE TABLE ${tables.store} (
  namespace_path VARCHAR2(4000) NOT NULL,
  item_key VARCHAR2(1024) NOT NULL,
  namespace CLOB CHECK (namespace IS JSON) NOT NULL,
  item_value CLOB CHECK (item_value IS JSON) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ${oracleConstraintName(
    tables.store,
    "PK"
  )} PRIMARY KEY (namespace_path, item_key)
)`;

export const getCreateStoreVectorTableSQL = (
  tables: OracleStoreMigrationTables,
  dims: number
): string => `CREATE TABLE ${tables.storeVectors} (
  namespace_path VARCHAR2(4000) NOT NULL,
  item_key VARCHAR2(1024) NOT NULL,
  field_path VARCHAR2(1024) NOT NULL,
  text_content CLOB,
  embedding VECTOR(${dims}, FLOAT32) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT ${oracleConstraintName(tables.storeVectors, "PK")} PRIMARY KEY (
    namespace_path,
    item_key,
    field_path
  )
)`;
