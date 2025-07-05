import * as pg from "pg";
import { HTTPException } from "hono/http-exception";
import type { PostgresPersistence } from "../persist/postgres.mjs";
import { isAuthMatchingPostgres } from "../../auth/custom.mjs";
import type { AuthFilters } from "../../auth/index.mjs";
import type { OnConflictBehavior } from "../types/index.mjs";

import Cursor from "pg-cursor";
import { 
  OpsAdapter, 
  PrimaryKey,
  OPTIONS,
  SEARCH_OPTIONS,
  GET_OPTIONS,
  PUT_OPTIONS as CORE_PUT_OPTIONS,
  PATCH_OPTIONS as CORE_PATCH_OPTIONS,
  DELETE_OPTIONS,
  SearchResponse,
  normalizeSearchOptions,
  normalizeOptions
} from "./types.mjs";

interface PUT_OPTIONS<ModelType extends Record<string, any>> extends CORE_PUT_OPTIONS<ModelType> {
  onConflict?: OnConflictBehavior;
  onConflictColumns?: string[];
  onConflictUpdateColumns?: string[];
}

const SCHEMA = {
  runs: "run",
  threads: "thread",
  assistants: "assistant",
  assistant_versions: "assistant_versions",
  retry_counter: "retry_counter",
}
export class PostgresAdapter<ModelType extends Record<string, any>> implements OpsAdapter<ModelType> {
  private persistence: PostgresPersistence;
  private conn: pg.Pool;
  private table: string;
  private primaryKey: string;
  private schema: string;
  private columnCache: Set<string> | undefined = undefined;

  constructor(conn: PostgresPersistence, table: keyof typeof SCHEMA, primaryKey: string, schema?: string) {
    this.persistence = conn;
    this.conn = conn.pool;

    if (!Object.keys(SCHEMA).includes(table)) {
      throw (`Cannot set table to ${table}. Allowed tables are ${Object.keys(SCHEMA).join(", ")}`)
    }

    this.table = SCHEMA[table as keyof typeof SCHEMA]
    this.primaryKey = primaryKey;
    this.schema = schema || 'public'
  }

  async get(options: GET_OPTIONS): Promise<ModelType | null> {
    if (!options.key && (!options.where || Object.keys(options.where).length === 0)) {
      return null;
    }
    
    const opts = await normalizeOptions(options) as GET_OPTIONS

    return this.with(async (client: pg.PoolClient) => {
      const { where: whereClause, whereValues } = this.buildWhereClause(opts.where);
      const queryText = `
        SELECT *
        FROM ${this.quote(this.table)}
        ${whereClause}
      `;
      const result = await client.query<ModelType>(queryText, whereValues);
      return result.rows[0] ?? null;
    });
  }

  async count(options: { where: Record<string, any>, authFilters: AuthFilters }): Promise<number> {
    const opts = await normalizeOptions(options) as Record<string, any>;
    const { where: whereInputs, authFilters } = opts;
    const { where, whereValues } = this.buildWhereClause(whereInputs, authFilters);
    const countQuery = `SELECT COUNT(*) FROM ${this.quote(this.table)} ${where}`;
    
    return this.with(async (client: pg.PoolClient) => {
      const result = await client.query<{ count: string }>(countQuery, whereValues);
      return parseInt(result.rows[0].count, 10);
    })
  }

  async *search(options: SEARCH_OPTIONS): AsyncGenerator<SearchResponse<ModelType>> {
    let opts = await normalizeSearchOptions(options); // Apply consistent defaults

    const self = this;
    yield* this.withGenerator(async function* (client: pg.PoolClient) {
      // Use the existing client instead of creating a new transaction
      const { where, whereValues } = self.buildWhereClause(opts.where, opts.authFilters);
      const countQuery = `SELECT COUNT(*) FROM ${self.quote(self.table)} ${where}`;
      const countResult = await client.query<{ count: string }>(countQuery, whereValues);
      const total = parseInt(countResult.rows[0].count, 10);
      
      if (total === 0) return;

      const {searchQuery, whereValues: searchWhereValues} = await self.buildSearchQuery(opts);
      const cursor = client.query(new Cursor(searchQuery, [...searchWhereValues]));

      let rows: ModelType[];
      while ((rows = await cursor.read(opts.limit || 100)).length > 0) {
        for (const item of rows) {
          yield { item, total };
        }
      }
    }.bind(this));
  }

  async where(options: SEARCH_OPTIONS = {}): Promise<ModelType[]> {
    const {searchQuery, whereValues} = await this.buildSearchQuery(options);

    return this.with(async (client: pg.PoolClient) => {
      return ((await client.query(searchQuery, whereValues))?.rows || []) as ModelType[];
    })
  }

  private async buildSearchQuery(options: SEARCH_OPTIONS = {}): Promise<{ searchQuery: string, whereValues: any[] }> {
      let opts = await normalizeSearchOptions(options); // Apply consistent defaults
      const { limit, offset, sort_by = this.primaryKey, sort_order, where: whereInputs, authFilters, } = opts;

      const { where, whereValues } = this.buildWhereClause(whereInputs, authFilters);
      const order = await this.buildOrderClause(sort_by, sort_order);

      const searchQuery = `
        SELECT * FROM ${this.quote(this.table)}
        ${where}
        ${order}
        LIMIT ${limit} OFFSET ${offset}
      `;

      return {searchQuery, whereValues}
  }

  async put(options: PUT_OPTIONS<ModelType>): Promise<ModelType> {
    const { model, onConflict, onConflictColumns, onConflictUpdateColumns } = await this.normalizePutOptions(options) as PUT_OPTIONS<ModelType>;
    return this.with(async (client: pg.PoolClient) => {
      const columns = Object.keys(model);
      const values = Object.values(model);

      let onConflictClause: string = ''; 

      // If on conflict behavior = 'raise', then do not include an on conflict clause; postgres will raise
      if (onConflictColumns && onConflictColumns.length > 0 && onConflict != "raise") {
        const actions: Record<string, string> = {
          "do_nothing": "NOTHING",
          "update": "UPDATE"
        }
        const action = actions[onConflict as string];
        const setClause = onConflictUpdateColumns && onConflictUpdateColumns.map((col) => `${this.quote(col)} = EXCLUDED.${this.quote(col)}`).join(", ");

        onConflictClause = `
          ON CONFLICT (
            ${onConflictColumns.map((col) => this.quote(col)).join(", ")}
          )
          DO ${action}
          ${action === "UPDATE" && setClause ? `SET ${setClause}` : ``}
        `;
      }

      const queryText = `
        INSERT INTO ${this.quote(this.table)} (${columns.map(col => this.quote(col)).join(", ")})
        VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})
        ${onConflictClause}
        RETURNING *
      `;

      const result = await client.query<ModelType>(queryText, values);
      return result.rows[0];
    });
  }

  async patch(options: CORE_PATCH_OPTIONS<ModelType>): Promise<ModelType> {
    const { key, model } = await this.normalizePutPatchOptions(options) as CORE_PATCH_OPTIONS<ModelType>;

    return this.with(async (client: pg.PoolClient) => {
      const columns = Object.keys(model);
      if (columns.length === 0) {
        // If there's nothing to patch, just get the current state.
        const current = await this.get({ key: key as PrimaryKey });
        if (!current) {
          throw new HTTPException(404, { message: "Model not found" });
        }
        return current;
      }
      
      // We start parameter indexing from count(whereValues) + 1
      const { where: whereClause, whereValues } = this.buildWhereClause(options.where);
      const setClause = columns
        .map((col, i) => `${this.quote(col)} = $${whereValues.length + i + 1}`)
        .join(", ");

      const queryText = `
        UPDATE ${this.quote(this.table)}
        SET ${setClause}
        ${whereClause}
        RETURNING *
      `;

      const queryValues = [...whereValues, ...Object.values(model)];
      const result = await client.query<ModelType>(queryText, queryValues);

      if (result.rowCount === 0) {
        // This means the WHERE clause didn't find a matching row.
        throw new HTTPException(404, { message: "Model not found" });
      }

      return result.rows[0];
    });
  }

  async all(): Promise<ModelType[]> {
    return this.with(async (client: pg.PoolClient) => {
      return (await client.query(`SELECT * FROM ${this.quote(this.table)}`)).rows;
    });
  }

  async delete(options: DELETE_OPTIONS): Promise<boolean> {
    const opts = await normalizeOptions(options) as DELETE_OPTIONS;

    return this.with(async (client: pg.PoolClient) => {
      const { where: whereClause, whereValues } = this.buildWhereClause(opts.where)

      const queryText = `
        DELETE FROM ${this.quote(this.table)}
        ${whereClause}
      `;
      const result = await client.query(queryText, whereValues);

      if (result.rowCount === 0) {
        throw new HTTPException(404, { message: "Model not found" });
      }

      return true;
    }).catch(() => {
      return false;
    });
  }

  async truncate() {
    return this.with(async (client: pg.PoolClient) => {
      const queryText = `TRUNCATE TABLE ${this.quote(this.table)}`;
      await client.query(queryText);
    });
  }

  async with<ModelType>(fn: (client: pg.PoolClient) => Promise<ModelType>): Promise<ModelType> {
    const client = await this.clientWithLogging();

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

  async *withGenerator<ModelType>(fn: (client: pg.PoolClient) => AsyncGenerator<ModelType>): AsyncGenerator<ModelType> {
    const client = await this.clientWithLogging();

    try {
      yield* await fn(client);
    } finally {
      client.release();
    }
  }

  async columns(): Promise<Set<string>> {
    if (this.columnCache) {
      return Promise.resolve(this.columnCache);
    }
    
    const columns = await this.fetchTableSchema();
    this.columnCache = columns
    return columns;
  }

  private quote(identifier: string): string {
    return identifier.split(".").map((part) => `"${
      part.replace(/^"(.*)"$/, "$1") // if the identifier is already quoted, remove the quotes
    }"`).join(".");
  }

  private buildWhereClause(whereInputs: any, authFilters?: any): { where: string; whereValues: any[] } {
    // 1. Encapsulate parameter state for cleaner function signatures
    const paramManager = {
      values: [] as any[],
      index: 1,
      add(value: any): string {
        this.values.push(value);
        return `$${this.index++}`;
      },
    };

    // Filter out undefined values from whereInputs
    const cleanWhereInputs = whereInputs ? Object.fromEntries(
      Object.entries(whereInputs).filter(([_, value]) => value !== undefined)
    ) : {};

    // Merge auth filters
    const mergedWhere = { ...cleanWhereInputs };
    if (authFilters) {
      const authJsonb = isAuthMatchingPostgres(authFilters); // Assumes this helper exists
      if (Object.keys(authJsonb).length > 0) {
        mergedWhere.metadata = { ...(mergedWhere.metadata || {}), ...authJsonb };
      }
    }

    const OPERATOR_MAP: { [key: string]: string } = {
      $lt: '<', $le: '<=', $gt: '>', $ge: '>=', $eq: '=', $ne: '!=',
    };

    /**
     * Generates SQL clauses for a given column and a condition object/value.
     * This is the core reusable logic for both regular and nested JSONB fields.
     */
    const processCondition = (column: string, condition: any, isJsonbContext = false): string[] => {
      const clauses: string[] = [];

      // Helper for IN/NOT IN clauses
      const buildInClause = (arr: any[], notIn = false) => {
        if (!Array.isArray(arr) || arr.length === 0) return [notIn ? '1=1' : '1=0'];
        const placeholders = arr.map(val => paramManager.add(val)).join(', ');
        return [`${column} ${notIn ? 'NOT IN' : 'IN'} (${placeholders})`];
      };

      if (Array.isArray(condition)) {
        return buildInClause(condition);
      }

      if (typeof condition !== 'object' || condition === null) {
        return [`${column} = ${paramManager.add(condition)}`];
      }

      for (const [op, opValue] of Object.entries(condition)) {
        if (OPERATOR_MAP[op]) {
          let fieldExpression = column;
          // When comparing JSONB text fields as numbers, a cast is required
          if (isJsonbContext && typeof opValue === 'number') {
            fieldExpression = `(${column})::numeric`;
          }
          clauses.push(`${fieldExpression} ${OPERATOR_MAP[op]} ${paramManager.add(opValue)}`);
        } else if (op === '$in') {
          clauses.push(...buildInClause(opValue as any[]));
        } else if (op === '$nin') {
          clauses.push(...buildInClause(opValue as any[], true));
        } else if (op === '$exists' && !isJsonbContext) { // $exists for regular columns
          clauses.push(`${column} IS ${opValue ? 'NOT NULL' : 'NULL'}`);
        }
      }
      return clauses;
    };
    
    /**
     * Main recursive function to build the entire WHERE clause.
     */
    const buildClauses = (whereObj: any): string => {
      const clauses: string[] = [];

      for (const [key, value] of Object.entries(whereObj || {})) {
        // Handle logical operators ($or, $and)
        if (key === '$or' || key === '$and') {
          if (!Array.isArray(value)) continue;
          const logicalOp = key === '$or' ? 'OR' : 'AND';
          const subClauses = value.map(buildClauses).filter(c => c);
          if (subClauses.length > 0) clauses.push(`(${subClauses.join(` ${logicalOp} `)})`);
          continue;
        }
        
        const column = key === 'key' ? this.primaryKey : `"${key}"`;

        // Handle special JSONB columns
        if ((key === 'metadata' || key === 'values') && typeof value === 'object' && value !== null) {
          const hasNestedOperators = Object.values(value).some(
            v => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).some(k => k.startsWith('$'))
          );

          if (hasNestedOperators) {
            for (const [fieldKey, fieldValue] of Object.entries(value as object)) {
              // Handle JSONB existence operator `?` which is structurally different
              if (typeof fieldValue === 'object' && fieldValue !== null && '$exists' in fieldValue) {
                clauses.push(fieldValue.$exists ? `${column} ? '${fieldKey}'` : `NOT (${column} ? '${fieldKey}')`);
              } else {
                // For all other operators, construct the field accessor and process normally
                const jsonbField = `${column}->>'${fieldKey}'`;
                clauses.push(...processCondition(jsonbField, fieldValue, true));
              }
            }
          } else {
            // Use JSONB containment for simple object queries
            clauses.push(`${column} @> ${paramManager.add(JSON.stringify(value))}::jsonb`);
          }
        } else {
          // Handle all other columns
          clauses.push(...processCondition(column, value));
        }
      }
      return clauses.join(' AND ');
    };

    const whereClause = buildClauses(mergedWhere);

    return {
      where: whereClause ? `WHERE ${whereClause}` : '',
      whereValues: paramManager.values,
    };
  }
  private async buildOrderClause(sort_by: string | string[], sort_order: string): Promise<string> {
    const columns = await this.columns();
    let sortByArray: string[] = [sort_by].flat()
    
    sortByArray.forEach((columnName) => {
      if (!columns.has(columnName)) {
        throw new Error(`Column '${columnName}' does not exist in table '${this.table}'`);
      }
    })

    const direction = sort_order === "desc" ? "DESC" : "ASC";
    return Promise.resolve(`ORDER BY ${sortByArray.map((column: string) => this.quote(column)).join(", ")} ${direction}`);
  }

  private async fetchTableSchema(): Promise<Set<string>> {
    return this.with(async (client: pg.PoolClient) => {
      const schemaQuery = `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = $1 
        AND table_schema = $2
      `;

      const result = await client.query(schemaQuery, [this.table, this.schema]);
      const columns = new Set<string>()

      for (const row of result.rows) {
        columns.add(row.column_name);
      }
      
      if (columns.size === 0) {
        throw new Error(`Table '${this.table}' not found or has no columns`);
      }
      
      return columns;
    })
  }

  private prepareStatement(query: string, params: any[]): string {
    let formatted = query;
    params.forEach((param, index) => {
      let paramStr: string;
      if (typeof param === 'object' && param !== null) {
        paramStr = JSON.stringify(param);
      } else if (typeof param === 'string') {
        paramStr = param;
      } else {
        paramStr = String(param);
      }
      formatted = formatted.replaceAll(`$${index + 1}`, `'${paramStr}'`);
    });
    return formatted;
  }

  public async warmSchemaCache(): Promise<void> {
    await this.columns();
  }

  private async normalizePutPatchOptions<ModelType extends Record<string, any>>(options: PUT_OPTIONS<ModelType> | CORE_PATCH_OPTIONS<ModelType>): Promise<PUT_OPTIONS<ModelType> | CORE_PATCH_OPTIONS<ModelType>> {
    const opts = await normalizeOptions(options) as PUT_OPTIONS<ModelType> | CORE_PATCH_OPTIONS<ModelType>

    if (!('key' in opts) && 'model' in opts && this.primaryKey in (opts.model as Record<string, any>)) {
      (opts as any).key = (opts.model as Record<string, any>)[this.primaryKey];
    }
    return opts;
  }

  private async normalizePutOptions<ModelType extends Record<string, any>>(options: PUT_OPTIONS<ModelType>): Promise<PUT_OPTIONS<ModelType>> {
    const opts = await normalizeOptions(options) as PUT_OPTIONS<ModelType>;
    const { key, model } = await this.normalizePutPatchOptions(opts) as PUT_OPTIONS<ModelType>;

    return {
      key,
      model,
      onConflict: opts.onConflict ?? "update",
      onConflictColumns: opts.onConflictColumns ?? [this.primaryKey].flat(),
      onConflictUpdateColumns: opts.onConflictUpdateColumns ?? Object.keys(model),
    };
  }

  private log(query: string, values?: any[]) {
    if (process.env.LOG_QUERIES === "true") {
      if (values && values.length > 0) {
        console.log(this.prepareStatement(query, values));
      } else {
        console.log(query)
      }
      console.log("----------------------\n");
    }
  }

  private async clientWithLogging(): Promise<pg.PoolClient> {
    const client = await this.conn.connect();

    if (process.env.LOG_QUERIES !== "true") {
      return client; // No logging needed, return original client
    }

    // Create a proxy that intercepts query calls without modifying the original client
    return new Proxy(client, {
      get: (target, prop) => {
        if (prop === 'query') {
          return (queryTextOrConfig: any, values?: any[]) => {
            // Only log if the first argument is a string (actual SQL query)
            if (typeof queryTextOrConfig === 'string') {
              this.log(queryTextOrConfig, values);
            }
            return target.query(queryTextOrConfig, values);
          };
        }
        return target[prop as keyof pg.PoolClient];
      }
    });
  }
}