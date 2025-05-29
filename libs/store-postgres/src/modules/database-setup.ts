import pg from "pg";
import { DatabaseCore } from "./database-core.js";
import { VectorIndexType, DistanceMetric } from "./types.js";

/**
 * Handles database schema creation, table setup, and index creation.
 */
export class DatabaseSetup {
  constructor(private core: DatabaseCore) {}

  async initialize(): Promise<void> {
    await this.core.withClient(async (client) => {
      await this.createSchema(client);
      await this.enableExtensions(client);
      await this.createTables(client);
      await this.createIndexes(client);
      await this.createTriggers(client);
    });
  }

  private async createSchema(client: pg.PoolClient): Promise<void> {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.core.schema}`);
  }

  private async enableExtensions(client: pg.PoolClient): Promise<void> {
    if (this.core.indexConfig) {
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      } catch (error) {
        console.warn("pgvector extension not available. Vector search disabled.", error);
      }
    }
  }

  private async createTables(client: pg.PoolClient): Promise<void> {
    // Create main store table
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.core.schema}.store (
        namespace_path TEXT NOT NULL,
        key TEXT NOT NULL,
        value JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMPTZ,
        PRIMARY KEY (namespace_path, key)
      )
    `);

    // Create vector table if needed
    if (this.core.indexConfig) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.core.schema}.store_vectors (
          namespace_path TEXT NOT NULL,
          key TEXT NOT NULL,
          field_path TEXT NOT NULL,
          text_content TEXT NOT NULL,
          embedding vector(${this.core.indexConfig.dims}) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (namespace_path, key, field_path),
          FOREIGN KEY (namespace_path, key) REFERENCES ${this.core.schema}.store(namespace_path, key) ON DELETE CASCADE
        )
      `);
    }
  }

  private async createIndexes(client: pg.PoolClient): Promise<void> {
    // Standard indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_store_namespace_path 
      ON ${this.core.schema}.store USING btree (namespace_path)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_store_value_gin 
      ON ${this.core.schema}.store USING gin (value)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_store_expires_at 
      ON ${this.core.schema}.store USING btree (expires_at) 
      WHERE expires_at IS NOT NULL
    `);

    // Vector indexes
    if (this.core.indexConfig) {
      await this.createVectorIndexes(client);
    }
  }

  private async createVectorIndexes(client: pg.PoolClient): Promise<void> {
    if (!this.core.indexConfig) return;

    const { indexType = 'hnsw', distanceMetric = 'cosine', createAllMetricIndexes = false } = this.core.indexConfig;
    
    const metricsToIndex: DistanceMetric[] = createAllMetricIndexes 
      ? ['cosine', 'l2', 'inner_product']
      : [distanceMetric];

    for (const metric of metricsToIndex) {
      await this.createVectorIndex(client, indexType, metric);
    }
  }

  private async createVectorIndex(
    client: pg.PoolClient,
    indexType: VectorIndexType,
    metric: DistanceMetric
  ): Promise<void> {
    if (!this.core.indexConfig) return;

    let metricSuffix: string;
    if (metric === 'cosine') {
      metricSuffix = 'cosine';
    } else if (metric === 'l2') {
      metricSuffix = 'l2';
    } else {
      metricSuffix = 'ip';
    }
    const indexName = `idx_store_vectors_embedding_${metricSuffix}_${indexType}`;
    
    const operatorClass = {
      'cosine': 'vector_cosine_ops',
      'l2': 'vector_l2_ops',
      'inner_product': 'vector_ip_ops'
    }[metric];

    if (indexType === 'hnsw') {
      const m = this.core.indexConfig.hnsw?.m || 16;
      const efConstruction = this.core.indexConfig.hnsw?.efConstruction || 200;
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${indexName}
        ON ${this.core.schema}.store_vectors USING hnsw (embedding ${operatorClass})
        WITH (m = ${m}, ef_construction = ${efConstruction})
      `);
    } else if (indexType === 'ivfflat') {
      const lists = this.core.indexConfig.ivfflat?.lists || 100;
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${indexName}
        ON ${this.core.schema}.store_vectors USING ivfflat (embedding ${operatorClass})
        WITH (lists = ${lists})
      `);
    }
  }

  private async createTriggers(client: pg.PoolClient): Promise<void> {
    await client.query(`
      CREATE OR REPLACE FUNCTION ${this.core.schema}.update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql'
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS update_store_updated_at ON ${this.core.schema}.store
    `);

    await client.query(`
      CREATE TRIGGER update_store_updated_at
      BEFORE UPDATE ON ${this.core.schema}.store
      FOR EACH ROW EXECUTE FUNCTION ${this.core.schema}.update_updated_at_column()
    `);
  }
} 