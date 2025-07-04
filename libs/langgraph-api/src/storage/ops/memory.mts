import { FileSystemPersistence } from "../persist.mjs";
import { HTTPException } from "hono/http-exception";
import type { Store } from "../types/store.mjs";
import { isAuthMatching } from "../../auth/custom.mjs";
import { 
  OpsAdapter,
  SearchResponse,
  GET_OPTIONS,
  SEARCH_OPTIONS,
  PUT_OPTIONS,
  PATCH_OPTIONS,
  DELETE_OPTIONS,
  normalizeSearchOptions,
  normalizeOptions,
  type QueryOperators,
} from "./types.mjs";

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isJsonbContained = (
  superset: Record<string, unknown> | undefined,
  subset: Record<string, unknown> | undefined,
): boolean => {
  if (superset == null || subset == null) return true;
  for (const [key, value] of Object.entries(subset)) {
    // Handle explicit null checks
    if (value === null) {
      if (superset[key] !== null) return false;
    } else if (superset[key] == null) {
      return false;
    } else if (isObject(value) && isObject(superset[key])) {
      if (!isJsonbContained(superset[key], value)) return false;
    } else if (superset[key] !== value) {
      return false;
    }
  }

  return true;
};

// Helper function to check if a value is a query operator object
const isQueryOperators = (value: any): value is QueryOperators => {
  return isObject(value) && Object.keys(value).some(key => key.startsWith('$'));
};

// Helper function to evaluate query operators
const evaluateOperators = (recordValue: any, operators: QueryOperators): boolean => {
  for (const [op, opValue] of Object.entries(operators)) {
    switch (op) {
      case '$lt':
        if (!(recordValue < opValue)) return false;
        break;
      case '$le':
        if (!(recordValue <= opValue)) return false;
        break;
      case '$gt':
        if (!(recordValue > opValue)) return false;
        break;
      case '$ge':
        if (!(recordValue >= opValue)) return false;
        break;
      case '$eq':
        if (recordValue != opValue) return false;
        break;
      case '$ne':
        if (recordValue == opValue) return false;
        break;
      case '$in':
        if (!Array.isArray(opValue) || !opValue.includes(recordValue)) return false;
        break;
      case '$nin':
        if (!Array.isArray(opValue) || opValue.includes(recordValue)) return false;
        break;
      case '$exists':
        const exists = recordValue !== undefined && recordValue !== null;
        if (exists !== opValue) return false;
        break;
      default:
        throw new Error(`Unsupported query operator: ${op}`);
    }
  }
  return true;
};

// Helper function to evaluate a where clause against a record
const evaluateWhereClause = (record: any, whereClause: any, primaryKey: string): boolean => {
  if (!whereClause || Object.keys(whereClause).length === 0) return true;

  return Object.entries(whereClause).every(([filterKey, filterValue]) => {
    if (filterKey === '$or') {
      // Logical OR: at least one condition must be true
      return Array.isArray(filterValue) && filterValue.some(condition => 
        evaluateWhereClause(record, condition, primaryKey)
      );
    } else if (filterKey === '$and') {
      // Logical AND: all conditions must be true
      return Array.isArray(filterValue) && filterValue.every(condition => 
        evaluateWhereClause(record, condition, primaryKey)
      );
    } else if (filterKey === "key") {
      const recordKey = record[primaryKey] as string;
      if (Array.isArray(filterValue)) {
        return filterValue.includes(recordKey);
      } else if (isQueryOperators(filterValue)) {
        return evaluateOperators(recordKey, filterValue);
      }
      return recordKey === filterValue;
    } else if (Array.isArray(filterValue)) {
      // Handle IN queries - check if record field value is in the array
      return filterValue.includes(record[filterKey]);
    } else if (isQueryOperators(filterValue)) {
      // Handle query operators like $lt, $gt, etc.
      return evaluateOperators(record[filterKey], filterValue);
    } else if (isObject(filterValue) && (filterKey === 'metadata' || filterKey === 'values')) {
      // Handle JSONB fields - check if this has nested operators
      const hasNestedOperators = Object.values(filterValue).some(fieldValue => 
        isObject(fieldValue) && !Array.isArray(fieldValue) && Object.keys(fieldValue).some(k => k.startsWith('$'))
      );
      
      if (hasNestedOperators) {
        // Handle nested field queries like { status: { $in: [...] } }
        return Object.entries(filterValue).every(([fieldKey, fieldValue]) => {
          const recordFieldValue = record[filterKey]?.[fieldKey];
          
          if (Array.isArray(fieldValue)) {
            return fieldValue.includes(recordFieldValue);
          } else if (isQueryOperators(fieldValue)) {
            return evaluateOperators(recordFieldValue, fieldValue);
          } else {
            return recordFieldValue == fieldValue;
          }
        });
      } else {
        // Use JSONB containment for simple nested object queries
        return isJsonbContained(record[filterKey], filterValue);
      }
    } else {
      return record[filterKey] == filterValue;
    }
  });
};

export class MemoryAdapter<ModelType extends Record<string, any>> implements OpsAdapter<ModelType> {
  private conn: FileSystemPersistence<Store>;
  private table: keyof Store;
  private primaryKey: string;

  constructor(conn: FileSystemPersistence<Store>, table: keyof Store, primaryKey: string) {
    this.conn = conn;
    this.table = table as keyof Store;
    this.primaryKey = primaryKey;
  }

  async get(options: GET_OPTIONS): Promise<ModelType | null> {
    if (!options.key && (!options.where || Object.keys(options.where).length === 0)) {
      return null;
    }
    
    const opts = await normalizeOptions(options) as GET_OPTIONS
    const records = await this.where({
      where: opts.where
    });
    if (records.length > 1) {
      throw("Get request returned > 1 result. Ensure you are querying for unique records");
    }
    return records[0] as ModelType || null;
  }

  async all(): Promise<ModelType[]> {
    return this.conn.with((STORE) => {
      return Object.values(STORE[this.table]);
    });
  }

  async *search(options: SEARCH_OPTIONS): AsyncGenerator<SearchResponse<ModelType>> {
    const self = this;
    let {
      limit,
      offset,
      sort_by,
      sort_order,
      where,
      authFilters
    } = await normalizeSearchOptions(options);

    where = Object.fromEntries(
      Object.entries(where).filter(([key, value]) => value != null)
    );

    yield* this.conn.withGenerator(async function* (STORE) {
      const allItems = await self.where({
        sort_by,
        sort_order,
        where,
        authFilters
      });
      const total = allItems.length;
      const paginated = allItems.slice(offset, offset + limit);

      for (const item of paginated) {
        yield { item, total } as SearchResponse<ModelType>;
      }
    })
  }

  async put(options: PUT_OPTIONS<ModelType>): Promise<ModelType> {
    return this.conn.with((STORE) => {
      if (!STORE[this.table]) {
        STORE[this.table] = {} as any;
      }

      const key = this.normalizeKey(options.key) ?? this.getModelKey(options.model);
      (STORE[this.table] as any)[key] = options.model;
      return options.model;
    });
  }

  async patch(options: PATCH_OPTIONS<ModelType>): Promise<ModelType> {
    return this.conn.with((STORE) => {
      const key = this.normalizeKey(options.key) ?? this.getModelKey(options.model);
      const existing = (STORE[this.table] as any)[key];
      if (!existing) {
        throw new HTTPException(404, { message: "Model not found" });
      }
      (STORE[this.table] as any)[key] = {
        ...existing,
        ...options.model,
      };
      return (STORE[this.table] as any)[key];
    });
  }

  async delete(options: DELETE_OPTIONS): Promise<boolean> {
    const opts = await normalizeOptions(options) as DELETE_OPTIONS;

    return this.conn.with(async (STORE) => {
      if (opts.where && Object.keys(opts.where).length > 0) {
        const existing = await this.where({
          where: opts.where
        });

        if (existing.length === 0) {
          return false;
        }

        existing.forEach((record) => {
          const key = this.getModelKey(record);
          delete (STORE[this.table] as any)[key];
        })
      }

      return true;
    });
  }

  private normalizeKey(key: any): string | undefined {
    if (key === undefined || key === null) {
      return undefined;
    }
    if (Array.isArray(key)) {
      return key.join('|');
    }
    return String(key);
  }

  private getModelKey(model: Partial<ModelType>): string {
    return model[this.primaryKey] as string;
  }

  async where(options: SEARCH_OPTIONS): Promise<ModelType[]> {
    let {
      limit,
      offset,
      sort_by,
      sort_order,
      where,
      authFilters
    } = await normalizeSearchOptions(options);

    where = Object.fromEntries(
      Object.entries(where).filter(([key, value]) => value != null)
    );

    return this.conn.with((STORE) => {
      let results = (Object.values((STORE[this.table] as any)) as ModelType[]).filter((record: ModelType) => {
        if (authFilters && !isAuthMatching(record["metadata"], authFilters)) return false;

        if (!where || Object.keys(where).length === 0) return true;

        return evaluateWhereClause(record, where, this.primaryKey);
      });

      // Handle sorting if provided
      if (sort_by && sort_order) {
        const sortField = Array.isArray(sort_by) ? sort_by[0] : sort_by;
        
        results = results.sort((a, b) => {
          const aVal = a[sortField];
          const bVal = b[sortField];

          if (aVal instanceof Date && bVal instanceof Date) {
            return sort_order === "desc"
              ? bVal.getTime() - aVal.getTime()
              : aVal.getTime() - bVal.getTime();
          }

          if (typeof aVal === 'string' && typeof bVal === 'string') {
            return sort_order === "desc"
              ? bVal.localeCompare(aVal)
              : aVal.localeCompare(bVal);
          }

          if (typeof aVal === 'number' && typeof bVal === 'number') {
              return sort_order === "desc" ? bVal - aVal : aVal - bVal;
          }

          return 0;
        });
      }

      // Apply pagination
      if (limit != null || offset != null) {
        const startIndex = offset || 0;
        const endIndex = limit != null ? startIndex + limit : undefined;
        results = results.slice(startIndex, endIndex);
      }

      return results;
    });
  }

  async truncate() {
    return this.conn.with((STORE) => {
      STORE[this.table] = {};
    });
  }
}
