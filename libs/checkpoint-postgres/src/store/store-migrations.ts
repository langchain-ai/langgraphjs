import { getStoreTablesWithSchema } from "./sql.js";
import { VectorIndexType, DistanceMetric } from "./modules/types.js";

/**
 * Store migration configuration
 */
export interface StoreMigrationConfig {
  schema: string;
  indexConfig?: {
    dims: number;
    indexType?: VectorIndexType;
    distanceMetric?: DistanceMetric;
    createAllMetricIndexes?: boolean;
    hnsw?: { m?: number; efConstruction?: number };
    ivfflat?: { lists?: number };
  };
}

/**
 * To add a new store migration, add a new string to the list returned by the getStoreMigrations function.
 * The position of the migration in the list is the version number.
 */
export const getStoreMigrations = (config: StoreMigrationConfig): string[] => {
  const { schema, indexConfig } = config;
  const STORE_TABLES = getStoreTablesWithSchema(schema);
  const migrations = [];

  // Migration 1: Create store migrations table
  migrations.push(`CREATE TABLE IF NOT EXISTS ${STORE_TABLES.store_migrations} (
    v INTEGER PRIMARY KEY
  );`);

  // Migration 2: Create main store table
  migrations.push(`CREATE TABLE IF NOT EXISTS ${STORE_TABLES.store} (
    namespace_path TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ,
    PRIMARY KEY (namespace_path, key)
  );`);

  // Migration 3: Create basic indexes
  migrations.push(`
    CREATE INDEX IF NOT EXISTS idx_store_namespace_path 
    ON ${STORE_TABLES.store} USING btree (namespace_path);
    
    CREATE INDEX IF NOT EXISTS idx_store_value_gin 
    ON ${STORE_TABLES.store} USING gin (value);
    
    CREATE INDEX IF NOT EXISTS idx_store_expires_at 
    ON ${STORE_TABLES.store} USING btree (expires_at) 
    WHERE expires_at IS NOT NULL;
  `);

  // Migration 4: Create update trigger
  migrations.push(`
    CREATE OR REPLACE FUNCTION "${schema}".update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ language 'plpgsql';

    DROP TRIGGER IF EXISTS update_store_updated_at ON ${STORE_TABLES.store};

    CREATE TRIGGER update_store_updated_at
    BEFORE UPDATE ON ${STORE_TABLES.store}
    FOR EACH ROW EXECUTE FUNCTION "${schema}".update_updated_at_column();
  `);

  // Vector-related migrations (only if indexConfig is provided)
  if (indexConfig) {
    // Migration 5: Enable vector extension
    migrations.push(`CREATE EXTENSION IF NOT EXISTS vector;`);

    // Migration 6: Create vector table
    migrations.push(`CREATE TABLE IF NOT EXISTS ${STORE_TABLES.store_vectors} (
      namespace_path TEXT NOT NULL,
      key TEXT NOT NULL,
      field_path TEXT NOT NULL,
      text_content TEXT NOT NULL,
      embedding vector(${indexConfig.dims}) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (namespace_path, key, field_path),
      FOREIGN KEY (namespace_path, key) REFERENCES ${STORE_TABLES.store}(namespace_path, key) ON DELETE CASCADE
    );`);

    // Migration 7: Create vector indexes
    const {
      indexType = "hnsw",
      distanceMetric = "cosine",
      createAllMetricIndexes = false,
    } = indexConfig;
    const metricsToIndex: DistanceMetric[] = createAllMetricIndexes
      ? ["cosine", "l2", "inner_product"]
      : [distanceMetric];

    for (const metric of metricsToIndex) {
      let metricSuffix: string;
      if (metric === "cosine") {
        metricSuffix = "cosine";
      } else if (metric === "l2") {
        metricSuffix = "l2";
      } else {
        metricSuffix = "ip";
      }

      const indexName = `idx_store_vectors_embedding_${metricSuffix}_${indexType}`;

      const operatorClassMap = {
        cosine: "vector_cosine_ops",
        l2: "vector_l2_ops",
        inner_product: "vector_ip_ops",
      } as const;
      const operatorClass = operatorClassMap[metric];

      let vectorIndexSql: string;
      if (indexType === "hnsw") {
        const m = indexConfig.hnsw?.m || 16;
        const efConstruction = indexConfig.hnsw?.efConstruction || 200;
        vectorIndexSql = `CREATE INDEX IF NOT EXISTS ${indexName}
          ON ${STORE_TABLES.store_vectors} USING hnsw (embedding ${operatorClass})
          WITH (m = ${m}, ef_construction = ${efConstruction});`;
      } else if (indexType === "ivfflat") {
        const lists = indexConfig.ivfflat?.lists || 100;
        vectorIndexSql = `CREATE INDEX IF NOT EXISTS ${indexName}
          ON ${STORE_TABLES.store_vectors} USING ivfflat (embedding ${operatorClass})
          WITH (lists = ${lists});`;
      } else {
        throw new Error(`Unsupported vector index type: ${indexType}`);
      }

      migrations.push(vectorIndexSql);
    }
  }

  return migrations;
};
