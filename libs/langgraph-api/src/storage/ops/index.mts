import type { Store } from "../types/store.mjs";
import { storageConfig } from "../config.mjs";
import { MemoryAdapter } from "./memory.mjs";
import { PostgresAdapter } from "./postgres.mjs";
import { FileSystemPersistence } from "../persist.mjs";
import { PostgresPersistence } from "../persist/postgres.mjs";

import { 
  GET_OPTIONS,
  SEARCH_OPTIONS,
  PUT_OPTIONS,
  PATCH_OPTIONS,
  DELETE_OPTIONS,
  SearchResponse,
 } from "./ops_adapter.mjs"
export class StorageOps<ModelType extends Record<string, any>> {
  private table: string;
  private primaryKey: string;
  private adapters: { memory: MemoryAdapter<ModelType> | null, postgres: PostgresAdapter<ModelType> | null } = { memory: null, postgres: null };

  constructor(table: keyof Store, primaryKey: string) {
    this.table = table;
    this.primaryKey = primaryKey;
  }

  async all(): Promise<ModelType[]> {
    const adapter = await this.adapter();
    return adapter.all();
  }

  async get(options: GET_OPTIONS): Promise<ModelType | null> {
    const adapter = await this.adapter();
    return adapter.get(options);
  }

  async *search(options: SEARCH_OPTIONS = {}): AsyncGenerator<SearchResponse<ModelType>> {
    const adapter = await this.adapter();
    yield* (adapter as any).search(options);
  }

  async where(options: SEARCH_OPTIONS = {}): Promise<ModelType[]> {
    const adapter = await this.adapter();
    return adapter.where(options);
  }

  async put(options: PUT_OPTIONS<ModelType>): Promise<ModelType | null> {
    const adapter = await this.adapter();
    return adapter.put(options);
  }

  async patch(options: PATCH_OPTIONS<ModelType>): Promise<ModelType> {
    const adapter = await this.adapter();
    return adapter.patch(options);
  }

  async delete(options: DELETE_OPTIONS): Promise<boolean> {
    const adapter = await this.adapter();
    return adapter.delete(options);
  }

  async truncate(): Promise<void> {
    const adapter = await this.adapter();
    return adapter.truncate();
  }

  private async adapter() {
    const conn = storageConfig.PERSISTENCE;

    if (storageConfig.PERSISTENCE_TYPE === "memory") {
      if (this.adapters.memory) return this.adapters.memory;

      this.adapters.memory = new MemoryAdapter<ModelType>(conn as FileSystemPersistence<Store>, this.table as keyof Store, this.primaryKey);
      return this.adapters.memory;
    } else {
      if (this.adapters.postgres) return this.adapters.postgres; 

      this.adapters.postgres = new PostgresAdapter<ModelType>(conn as PostgresPersistence, this.table as keyof Store, this.primaryKey)
      return this.adapters.postgres;
    }
  }
}