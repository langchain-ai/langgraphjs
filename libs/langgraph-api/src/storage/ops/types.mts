import type { AuthFilters } from "../../auth/index.mjs";

export type BasePrimaryKey = string | number;
export type PrimaryKey = BasePrimaryKey | BasePrimaryKey[];

// Query operators for enhanced filtering
export type QueryOperators = {
  $lt?: any;       // less than
  $le?: any;       // less than or equal
  $gt?: any;       // greater than
  $ge?: any;       // greater than or equal
  $eq?: any;       // equal (explicit)
  $ne?: any;       // not equal
  $in?: any[];     // in array
  $nin?: any[];    // not in array
  $exists?: boolean; // field exists
  $or?: WhereClause[]; // logical OR
  $and?: WhereClause[]; // logical AND
};

export type WhereFieldValue = any | QueryOperators | any[];

export type WhereClause = {
  // Query for simple key-value equality checks, e.g., { status: 'idle' }
  // Or enhanced queries, e.g., { created_at: { $lt: new Date() } }
  [key: string]: WhereFieldValue;
  metadata?: Record<string, any>;
  values?: Record<string, any>;
}

export interface GET_OPTIONS {
  key?: PrimaryKey;
  where?: WhereClause;
}
export interface SEARCH_OPTIONS {
  batchSize?: number;
  sort_by?: string | string[];
  sort_order?: "asc" | "desc";
  limit?: number;
  offset?: number;
  where?: WhereClause;
  authFilters?: AuthFilters;
}

export interface SearchResponse<ModelType extends Record<string, any>> {
  item: ModelType;
  total: number;
}

export interface PUT_OPTIONS<ModelType extends Record<string, any>> {
  key?: PrimaryKey;
  where?: WhereClause;
  model: ModelType;
}

export interface PATCH_OPTIONS<ModelType extends Record<string, any>> {
  key?: PrimaryKey;
  where?: WhereClause;
  model: Partial<ModelType>;
}
export interface DELETE_OPTIONS {
  where: WhereClause;
}

export type OPTIONS = GET_OPTIONS | SEARCH_OPTIONS | PUT_OPTIONS<any> | PATCH_OPTIONS<any> | DELETE_OPTIONS;

export async function normalizeOptions(options: OPTIONS): Promise<OPTIONS> {
  options.where = options.where ?? {}
  if ("key" in options && options.key !== undefined) {
    options.where.key = options.key;
  }
  return options;
}

export async function normalizeSearchOptions(options: SEARCH_OPTIONS) {
  const opts = await normalizeOptions(options) as SEARCH_OPTIONS;

  return {
    limit: opts.limit ?? 100,
    offset: opts.offset ?? 0,
    sort_by: opts.sort_by,
    sort_order: opts.sort_order ?? "asc",
    where: opts.where ?? {},
    authFilters: opts.authFilters ?? undefined,
  };
}
export interface OpsAdapter<ModelType extends Record<string, any>> {
  get(options: GET_OPTIONS): Promise<ModelType | null>;
  search(options: SEARCH_OPTIONS): AsyncGenerator<SearchResponse<ModelType>>;
  where(options: SEARCH_OPTIONS): Promise<ModelType[]>;
  put(options: PUT_OPTIONS<ModelType>): Promise<ModelType>;
  patch(options: PATCH_OPTIONS<ModelType>): Promise<ModelType>;
  delete(options: DELETE_OPTIONS): Promise<boolean>;
  all(): Promise<ModelType[]>;
  truncate(): Promise<void>;
}