declare module "oracledb" {
  export type ExecuteOptions = Record<string, unknown>;
  export type BindParameters = Record<string, unknown>;

  export interface Result<T = Record<string, unknown>> {
    rows?: T[];
    rowsAffected?: number;
  }

  export interface Connection {
    execute<T = Record<string, unknown>>(
      sql: string,
      binds?: BindParameters,
      options?: ExecuteOptions
    ): Promise<Result<T>>;
    executeMany<T extends BindParameters = BindParameters>(
      sql: string,
      binds: T[],
      options?: ExecuteOptions
    ): Promise<Result>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
    release?(): Promise<void>;
  }

  export interface Pool {
    getConnection(): Promise<Connection>;
    close(drainTime?: number): Promise<void>;
  }

  export function getConnection(
    options?: Record<string, unknown>
  ): Promise<Connection>;
  export function createPool(options?: Record<string, unknown>): Promise<Pool>;

  const oracledb: {
    OUT_FORMAT_OBJECT: number;
    STRING: number;
    BUFFER: number;
    CLOB: number;
    BLOB: number;
    NUMBER: number;
    getConnection: typeof getConnection;
    createPool: typeof createPool;
  };

  export const OUT_FORMAT_OBJECT: number;
  export const STRING: number;
  export const BUFFER: number;
  export const CLOB: number;
  export const BLOB: number;
  export const NUMBER: number;

  export default oracledb;
}
