// Copyright (c) 2026, Oracle and/or its affiliates.
import { describe, expect, test } from "vitest";

import {
  assertStoredIndexConfigMatches,
  createConfiguredVectorIndexSQL,
  configuredVectorIndexName,
  defaultTableSuffix,
  distanceMetricSQL,
  organizationClause,
  parametersClause,
  pythonJsonDumps,
  resolveDistanceMetric,
  scoreFromDistanceSQL,
  storeConfigDistanceType,
  storeConfigEmbedFields,
  storeConfigIndexParams,
  targetAccuracyClause,
  validateOracleIndexConfig,
  type OracleIndexConfig,
} from "../store/index-config.js";
import {
  STORE_MIGRATIONS,
  VECTOR_MIGRATIONS,
} from "../store/migrations.js";

const embeddings = {
  async embedDocuments() {
    return [];
  },
  async embedQuery() {
    return [];
  },
} as never;

function indexConfig(
  overrides: Partial<OracleIndexConfig> = {}
): OracleIndexConfig {
  return { dims: 2, embeddings, ...overrides } as OracleIndexConfig;
}

const VECTOR_TABLE = "STORE_VECTORS_MEMORY";

describe("Python JSON compatibility", () => {
  test("matches json.dumps(sort_keys=True) separators and key order", () => {
    // Reference values produced by CPython:
    //   json.dumps({...}, sort_keys=True)
    expect(
      pythonJsonDumps({
        neighbors: 1,
        neighbor_partitions: 2,
        type: "ivf",
        samples_per_partition: 3,
      })
    ).toBe(
      '{"neighbor_partitions": 2, "neighbors": 1, "samples_per_partition": 3, "type": "ivf"}'
    );

    expect(pythonJsonDumps({ dims: 2, fields: ["a", "b"] })).toBe(
      '{"dims": 2, "fields": ["a", "b"]}'
    );
  });

  test("sorts keys by code point rather than locale", () => {
    // localeCompare would place "a" before "A" in most locales; Python does not.
    expect(pythonJsonDumps({ a: 1, A: 2, _z: 3 })).toBe(
      '{"A": 2, "_z": 3, "a": 1}'
    );
  });

  test("escapes non-ASCII the way ensure_ascii=True does", () => {
    // The input is "t", U+00E9 (e acute), U+007F (DEL), "st", written as
    // escapes rather than literals: DEL is invisible in an editor and does
    // not survive copy-paste, yet it is the point of the case, since
    // ensure_ascii=True escapes it and JSON.stringify does not.
    //
    // CPython reference:
    //   json.dumps({"fields": ["t\u00e9\u007fst"]}, sort_keys=True)
    expect(pythonJsonDumps({ fields: ["t\u00e9\u007fst"] })).toBe(
      '{"fields": ["t\\u00e9\\u007fst"]}'
    );
  });

  test("rejects values that cannot be represented", () => {
    expect(() => pythonJsonDumps({ n: Number.NaN })).toThrow(
      "cannot serialize the non-finite number NaN"
    );
  });
});

describe("table suffix derivation", () => {
  // Every expected digest below is the output of Python _generate_suffix for
  // the same configuration.
  test.each([
    [indexConfig({ fields: ["text"] }), "403c86"],
    [
      indexConfig({
        fields: ["text"],
        index_type: { type: "hnsw", neighbors: 16, efconstruction: 200 },
      }),
      "4516c3",
    ],
    [
      indexConfig({
        fields: ["text"],
        index_type: {
          type: "ivf",
          neighbor_partitions: 5,
          samples_per_partition: 3,
          min_vectors_per_partition: 1,
        },
      }),
      "304dba",
    ],
    [
      indexConfig({
        dims: 8,
        index_type: { type: "hnsw", distance_metric: "EUCLIDEAN" },
      }),
      "47892b",
    ],
    [
      indexConfig({
        dims: 4,
        fields: ["a", "b"],
        index_type: { type: "hnsw", distance_metric: "DOT", neighbors: 32 },
      }),
      "4c4e41",
    ],
  ])("matches the Python suffix for %#", (config, expected) => {
    expect(defaultTableSuffix(config)).toBe(expected);
  });

  test("isolates tables per index type instead of collapsing onto one hash", () => {
    const hnsw = defaultTableSuffix(
      indexConfig({ fields: ["text"], index_type: { type: "hnsw" } })
    );
    const hnswTuned = defaultTableSuffix(
      indexConfig({
        fields: ["text"],
        index_type: { type: "hnsw", neighbors: 16, efconstruction: 200 },
      })
    );
    const ivf = defaultTableSuffix(
      indexConfig({
        fields: ["text"],
        index_type: { type: "ivf", neighbor_partitions: 5 },
      })
    );
    const euclidean = defaultTableSuffix(
      indexConfig({
        fields: ["text"],
        index_type: { type: "hnsw", distance_metric: "EUCLIDEAN" },
      })
    );

    expect(new Set([hnsw, hnswTuned, ivf, euclidean]).size).toBe(4);
    // An omitted index_type hashes exactly like an explicit default one.
    expect(defaultTableSuffix(indexConfig({ fields: ["text"] }))).toBe(hnsw);
  });

  test("uses novec without an index configuration", () => {
    expect(defaultTableSuffix(undefined)).toBe("novec");
  });
});

describe("index configuration validation", () => {
  test("accepts the documented HNSW and IVF shapes", () => {
    expect(() =>
      validateOracleIndexConfig(
        indexConfig({
          accuracy: 90,
          index_type: {
            type: "hnsw",
            neighbors: 16,
            efconstruction: 200,
            distance_metric: "COSINE",
          },
        })
      )
    ).not.toThrow();

    expect(() =>
      validateOracleIndexConfig(
        indexConfig({
          index_type: {
            type: "ivf",
            neighbor_partitions: 10,
            samples_per_partition: 5,
            min_vectors_per_partition: 0,
            distance_metric: "euclidean",
          },
        })
      )
    ).not.toThrow();
  });

  test("allows neighbors and efconstruction independently, as Python does", () => {
    expect(() =>
      validateOracleIndexConfig(
        indexConfig({ index_type: { type: "hnsw", neighbors: 16 } })
      )
    ).not.toThrow();
    expect(() =>
      validateOracleIndexConfig(
        indexConfig({ index_type: { type: "hnsw", efconstruction: 200 } })
      )
    ).not.toThrow();
  });

  test("rejects unknown index_type keys", () => {
    expect(() =>
      validateOracleIndexConfig(
        indexConfig({
          index_type: { type: "hnsw", neighbor_partitions: 4 } as never,
        })
      )
    ).toThrow("index_type contains unsupported keys: neighbor_partitions");

    expect(() =>
      validateOracleIndexConfig(
        indexConfig({
          index_type: { type: "ivf", efconstruction: 4 } as never,
        })
      )
    ).toThrow("index_type contains unsupported keys: efconstruction");
  });

  test("rejects unknown index types and non-object index_type", () => {
    expect(() =>
      validateOracleIndexConfig(
        indexConfig({ index_type: { type: "flat" } as never })
      )
    ).toThrow('index_type.type must be "hnsw" or "ivf"');

    expect(() =>
      validateOracleIndexConfig(indexConfig({ index_type: "hnsw" as never }))
    ).toThrow("index_type must be a plain object");
  });

  test("rejects out-of-range numeric options", () => {
    const cases: Array<[Partial<OracleIndexConfig>, string]> = [
      [{ accuracy: 0 }, "index accuracy must be between 1 and 100"],
      [{ accuracy: 101 }, "index accuracy must be between 1 and 100"],
      [
        { index_type: { type: "hnsw", neighbors: 1 } },
        "index_type.neighbors must be between 2 and 2048",
      ],
      [
        { index_type: { type: "hnsw", neighbors: 2049 } },
        "index_type.neighbors must be between 2 and 2048",
      ],
      [
        { index_type: { type: "hnsw", efconstruction: 0 } },
        "index_type.efconstruction must be between 1 and 65535",
      ],
      [
        { index_type: { type: "hnsw", efconstruction: 65536 } },
        "index_type.efconstruction must be between 1 and 65535",
      ],
      [
        { index_type: { type: "ivf", neighbor_partitions: 0 } },
        "index_type.neighbor_partitions must be between 1 and 10000000",
      ],
      [
        { index_type: { type: "ivf", neighbor_partitions: 10000001 } },
        "index_type.neighbor_partitions must be between 1 and 10000000",
      ],
      [
        { index_type: { type: "ivf", samples_per_partition: 0 } },
        "index_type.samples_per_partition must be between 1",
      ],
      [
        { index_type: { type: "ivf", min_vectors_per_partition: -1 } },
        "index_type.min_vectors_per_partition must be between 0",
      ],
    ];

    for (const [overrides, message] of cases) {
      expect(() =>
        validateOracleIndexConfig(indexConfig(overrides))
      ).toThrow(message);
    }
  });

  test("rejects non-integer numeric options", () => {
    for (const value of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_VALUE,
      true,
      null,
      "16",
    ]) {
      expect(() =>
        validateOracleIndexConfig(
          indexConfig({
            index_type: { type: "hnsw", neighbors: value as never },
          })
        )
      ).toThrow("index_type.neighbors must be an integer");
    }
  });

  test("rejects unsupported distance metrics and accepts any capitalization", () => {
    expect(resolveDistanceMetric({ type: "hnsw" })).toBe("COSINE");
    expect(resolveDistanceMetric(undefined)).toBe("COSINE");
    expect(
      resolveDistanceMetric({ type: "hnsw", distance_metric: "euclidean" })
    ).toBe("EUCLIDEAN");
    expect(
      resolveDistanceMetric({ type: "hnsw", distance_metric: "DOT" })
    ).toBe("DOT");

    expect(() =>
      resolveDistanceMetric({
        type: "hnsw",
        distance_metric: "MANHATTAN" as never,
      })
    ).toThrow("distance_metric must be one of COSINE, EUCLIDEAN, DOT");
    expect(() =>
      resolveDistanceMetric({ type: "hnsw", distance_metric: 1 as never })
    ).toThrow("distance_metric must be a string");
  });
});

describe("SQL injection resistance", () => {
  // Every one of these values would land inside vector DDL if it were not
  // rejected before the statement is built.
  const injections: Array<[string, Partial<OracleIndexConfig>]> = [
    [
      "neighbors carrying SQL text",
      { index_type: { type: "hnsw", neighbors: "16) PARAMETERS (x" as never } },
    ],
    [
      "efconstruction carrying a statement terminator",
      {
        index_type: {
          type: "hnsw",
          efconstruction: "200); DROP TABLE STORE_MEMORY --" as never,
        },
      },
    ],
    [
      "neighbor_partitions carrying SQL text",
      {
        index_type: {
          type: "ivf",
          neighbor_partitions: "1 PARALLEL 8" as never,
        },
      },
    ],
    [
      "samples_per_partition carrying SQL text",
      {
        index_type: {
          type: "ivf",
          samples_per_partition: "1, min_vectors_per_partition 9" as never,
        },
      },
    ],
    [
      "min_vectors_per_partition carrying SQL text",
      {
        index_type: {
          type: "ivf",
          min_vectors_per_partition: "0) --" as never,
        },
      },
    ],
    ["accuracy carrying SQL text", { accuracy: "90 PARALLEL 8" as never }],
    [
      "distance_metric carrying SQL text",
      {
        index_type: {
          type: "hnsw",
          distance_metric: "COSINE PARAMETERS (type HNSW" as never,
        },
      },
    ],
    [
      "an injected extra index_type key",
      {
        index_type: {
          type: "hnsw",
          "neighbors 1) --": 1,
        } as never,
      },
    ],
    ["dims carrying SQL text", { dims: "2) --" as never }],
  ];

  test.each(injections)("rejects %s", (_label, overrides) => {
    const config = indexConfig(overrides);
    expect(() => validateOracleIndexConfig(config)).toThrow();
    expect(() => createConfiguredVectorIndexSQL(VECTOR_TABLE, config)).toThrow();
  });

  test("never emits an unvalidated distance metric into DDL", () => {
    // Exponent and hexadecimal notation would still render as text in SQL, so
    // only safe integers may reach the statement.
    expect(() =>
      createConfiguredVectorIndexSQL(
        VECTOR_TABLE,
        indexConfig({ index_type: { type: "hnsw", neighbors: 1e21 as never } })
      )
    ).toThrow("index_type.neighbors must be an integer");

    const sql = createConfiguredVectorIndexSQL(
      VECTOR_TABLE,
      indexConfig({
        index_type: { type: "hnsw", distance_metric: "euclidean" },
      })
    );
    expect(sql).toContain("DISTANCE EUCLIDEAN");
    expect(sql).not.toContain("euclidean");
  });

  test("rejects a vector table name that is not a plain identifier", () => {
    expect(() =>
      createConfiguredVectorIndexSQL(
        'STORE_VECTORS_X"; DROP TABLE STORE_X; --',
        indexConfig()
      )
    ).toThrow("Invalid Oracle identifier");
  });
});

describe("vector index DDL", () => {
  test("builds the default HNSW statement", () => {
    expect(createConfiguredVectorIndexSQL(VECTOR_TABLE, indexConfig())).toBe(
      `CREATE VECTOR INDEX ${configuredVectorIndexName(
        VECTOR_TABLE,
        indexConfig()
      )}
ON ${VECTOR_TABLE} (embedding)
ORGANIZATION INMEMORY NEIGHBOR GRAPH
DISTANCE COSINE`
    );
  });

  test("builds a tuned HNSW statement with accuracy and parameters", () => {
    const config = indexConfig({
      accuracy: 95,
      index_type: {
        type: "hnsw",
        neighbors: 16,
        efconstruction: 200,
        distance_metric: "DOT",
      },
    });
    const sql = createConfiguredVectorIndexSQL(VECTOR_TABLE, config);

    expect(sql).toContain("ORGANIZATION INMEMORY NEIGHBOR GRAPH");
    expect(sql).toContain("DISTANCE DOT");
    expect(sql).toContain("WITH TARGET ACCURACY 95");
    expect(sql).toContain(
      "PARAMETERS (type HNSW, neighbors 16, efconstruction 200)"
    );
  });

  test("builds an IVF statement using Python's parameter spelling", () => {
    const config = indexConfig({
      index_type: {
        type: "ivf",
        neighbor_partitions: 5,
        samples_per_partition: 3,
        min_vectors_per_partition: 1,
      },
    });
    const sql = createConfiguredVectorIndexSQL(VECTOR_TABLE, config);

    expect(sql).toContain("ORGANIZATION NEIGHBOR PARTITIONS");
    expect(sql).toContain(
      "PARAMETERS (type IVF, neighbor partitions 5, samples_per_partition 3, min_vectors_per_partition 1)"
    );
  });

  test("omits the PARAMETERS clause when index_type is absent", () => {
    expect(parametersClause(indexConfig())).toBe("");
    expect(parametersClause(indexConfig({ index_type: { type: "hnsw" } }))).toBe(
      "PARAMETERS (type HNSW)"
    );
    expect(organizationClause(indexConfig())).toBe("INMEMORY NEIGHBOR GRAPH");
    expect(
      organizationClause(indexConfig({ index_type: { type: "ivf" } }))
    ).toBe("NEIGHBOR PARTITIONS");
    expect(targetAccuracyClause(indexConfig())).toBe("");
  });

  test("derives a stable index name per configuration", () => {
    const first = configuredVectorIndexName(VECTOR_TABLE, indexConfig());
    const second = configuredVectorIndexName(VECTOR_TABLE, indexConfig());
    const other = configuredVectorIndexName(
      VECTOR_TABLE,
      indexConfig({ accuracy: 90 })
    );

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^STORE_VECTORS_MEMORY_IDX_[0-9A-F]{6}$/);
  });
});

describe("vector search scoring", () => {
  test("converts distance to a score per metric, as Python does", () => {
    expect(scoreFromDistanceSQL(indexConfig(), "sc.distance")).toBe(
      "1 - sc.distance"
    );
    expect(
      scoreFromDistanceSQL(
        indexConfig({ index_type: { type: "hnsw", distance_metric: "DOT" } }),
        "sc.distance"
      )
    ).toBe("-sc.distance");
    expect(
      distanceMetricSQL(
        indexConfig({
          index_type: { type: "ivf", distance_metric: "euclidean" },
        })
      )
    ).toBe("EUCLIDEAN");
  });
});

describe("STORE_CONFIGS registration values", () => {
  test("matches the columns Python writes", () => {
    const config = indexConfig({
      fields: ["text", "summary"],
      accuracy: 90,
      index_type: { type: "ivf", neighbor_partitions: 4 },
    });

    expect(storeConfigDistanceType(config)).toBe("COSINE");
    expect(storeConfigEmbedFields(config)).toBe("text,summary");
    expect(storeConfigIndexParams(config)).toEqual({
      type: "ivf",
      neighbor_partitions: 4,
      accuracy: 90,
    });
  });

  test("defaults fields and accuracy the way Python does", () => {
    const config = indexConfig();
    expect(storeConfigEmbedFields(config)).toBe("$");
    expect(storeConfigIndexParams(config)).toEqual({
      type: "hnsw",
      accuracy: null,
    });
  });
});

describe("stored configuration validation", () => {
  const stored = {
    detectedDims: 2,
    distanceType: "COSINE",
    indexParams: { type: "hnsw", neighbors: 16, accuracy: null },
  };
  const config = indexConfig({
    index_type: { type: "hnsw", neighbors: 16 },
  });

  test("accepts a matching configuration", () => {
    expect(() =>
      assertStoredIndexConfigMatches("memory", config, stored)
    ).not.toThrow();
  });

  test("accepts index_params stored as a JSON string", () => {
    expect(() =>
      assertStoredIndexConfigMatches("memory", config, {
        ...stored,
        indexParams: JSON.stringify(stored.indexParams),
      })
    ).not.toThrow();
  });

  test("rejects a dimension mismatch", () => {
    expect(() =>
      assertStoredIndexConfigMatches("memory", config, {
        ...stored,
        detectedDims: 8,
      })
    ).toThrow(
      'Dimension mismatch for tableSuffix "memory": existing 8 dimensions, provided 2'
    );
  });

  test("rejects a distance metric mismatch", () => {
    expect(() =>
      assertStoredIndexConfigMatches("memory", config, {
        ...stored,
        distanceType: "EUCLIDEAN",
      })
    ).toThrow(
      'Distance type mismatch for tableSuffix "memory": existing EUCLIDEAN, provided COSINE'
    );
  });

  test("rejects an accuracy mismatch", () => {
    expect(() =>
      assertStoredIndexConfigMatches("memory", config, {
        ...stored,
        indexParams: { type: "hnsw", neighbors: 16, accuracy: 90 },
      })
    ).toThrow('Index accuracy mismatch for tableSuffix "memory"');
  });

  test("rejects an index parameter mismatch", () => {
    expect(() =>
      assertStoredIndexConfigMatches("memory", config, {
        ...stored,
        indexParams: { type: "hnsw", neighbors: 32, accuracy: null },
      })
    ).toThrow('Index parameter mismatch for tableSuffix "memory"');
  });

  test("rejects unusable stored index parameters", () => {
    expect(() =>
      assertStoredIndexConfigMatches("memory", config, {
        ...stored,
        indexParams: "{not json",
      })
    ).toThrow("Stored index configuration is not valid JSON");

    expect(() =>
      assertStoredIndexConfigMatches("memory", config, {
        ...stored,
        indexParams: "[1, 2]",
      })
    ).toThrow("Stored index configuration must decode to a JSON object");
  });
});

describe("build hints that stay out of the shared identity", () => {
  test("appends PARALLEL last, after PARAMETERS", () => {
    const sql = createConfiguredVectorIndexSQL(
      VECTOR_TABLE,
      indexConfig({
        parallel: 4,
        index_type: { type: "ivf", neighbor_partitions: 2 },
      })
    );
    const lines = sql.split("\n");
    expect(lines[lines.length - 1]).toBe("PARALLEL 4");
    expect(lines[lines.length - 2]).toContain("PARAMETERS (type IVF");
  });

  test("uses a caller supplied index name", () => {
    expect(
      configuredVectorIndexName(
        VECTOR_TABLE,
        indexConfig({ index_name: "lg_memory_idx" })
      )
    ).toBe("LG_MEMORY_IDX");
  });

  test("rejects an index name that is not a plain identifier", () => {
    for (const index_name of ["1BAD", "BAD NAME", 'BAD"NAME', "BAD;DROP"]) {
      expect(() =>
        validateOracleIndexConfig(indexConfig({ index_name }))
      ).toThrow("Invalid Oracle identifier");
      expect(() =>
        createConfiguredVectorIndexSQL(VECTOR_TABLE, indexConfig({ index_name }))
      ).toThrow("Invalid Oracle identifier");
    }
  });

  test("rejects parallelism that is not a positive integer", () => {
    for (const parallel of [0, -1, 1.5, "8) --" as never, Number.NaN]) {
      expect(() =>
        validateOracleIndexConfig(indexConfig({ parallel }))
      ).toThrow("index parallel must be");
    }
  });

  test("keeps parallel and index_name out of the suffix and STORE_CONFIGS", () => {
    const plain = indexConfig({ fields: ["text"] });
    const hinted = indexConfig({
      fields: ["text"],
      parallel: 8,
      index_name: "CUSTOM_IDX",
    });

    // Python knows neither option, so neither may change which tables the
    // store resolves to or what it registers.
    expect(defaultTableSuffix(hinted)).toBe(defaultTableSuffix(plain));
    expect(storeConfigIndexParams(hinted)).toEqual(
      storeConfigIndexParams(plain)
    );
  });
});

describe("store migrations", () => {
  const tables = {
    store: "STORE_MEMORY",
    storeVectors: VECTOR_TABLE,
    storeMigrations: "STORE_MIGRATIONS_MEMORY",
    vectorMigrations: "VECTOR_MIGRATIONS_MEMORY",
  };

  test("keeps the store versions Python assigned", () => {
    const sql = STORE_MIGRATIONS.map((migration) =>
      migration.sql({ tables })
    );

    expect(sql).toHaveLength(5);
    expect(sql[0]).toContain("CREATE TABLE STORE_MEMORY");
    expect(sql[1]).toContain("(prefix) ONLINE");
    expect(sql[2]).toContain("(expires_at) ONLINE");
    expect(sql[3]).toContain("CREATE TABLE STORE_CONFIGS");
    expect(sql[4]).toContain("IDX_STORE_CONFIGS_TABLE_SUFFIX");
    expect(STORE_MIGRATIONS.every((m) => m.condition === undefined)).toBe(true);
  });

  test("creates the vector table then its index, as Python's VECTOR_MIGRATIONS do", () => {
    const context = { tables, index: indexConfig() };

    expect(VECTOR_MIGRATIONS).toHaveLength(2);
    expect(VECTOR_MIGRATIONS[0].sql(context)).toContain(
      `CREATE TABLE ${VECTOR_TABLE}`
    );
    expect(VECTOR_MIGRATIONS[0].sql(context)).toContain("embedding VECTOR(2)");
    expect(VECTOR_MIGRATIONS[1].sql(context)).toContain("CREATE VECTOR INDEX");
  });

  test("skips the index migration without an index configuration", () => {
    expect(VECTOR_MIGRATIONS[1].condition?.({ tables })).toBe(false);
    expect(VECTOR_MIGRATIONS[1].condition?.({ tables, index: indexConfig() })).toBe(
      true
    );
    expect(() => VECTOR_MIGRATIONS[0].sql({ tables })).toThrow(
      "vector migrations require an index configuration"
    );
  });
});