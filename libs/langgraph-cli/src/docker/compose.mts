import { $ } from "execa";
import * as yaml from "yaml";
import { z } from "zod";
import { getExecaOptions } from "./shell.mjs";

export const DEFAULT_POSTGRES_URI =
  "postgres://postgres:postgres@langgraph-postgres:5432/postgres?sslmode=disable";

const REDIS = {
  image: "redis:6",
  healthcheck: {
    test: "redis-cli ping",
    start_period: "10s",
    timeout: "1s",
    retries: 5,
  },
};

const DB = {
  image: "pgvector/pgvector:pg16",
  // TODO: make exposing postgres optional
  // ports: ['5433:5432'],
  expose: ["5432"],
  command: ["postgres", "-c", "shared_preload_libraries=vector"],
  environment: {
    POSTGRES_DB: "postgres",
    POSTGRES_USER: "postgres",
    POSTGRES_PASSWORD: "postgres",
  },
  volumes: ["langgraph-data:/var/lib/postgresql/data"],
  healthcheck: {
    test: "pg_isready -U postgres",
    start_period: "10s",
    timeout: "1s",
    retries: 5,
  },
};

interface Version {
  major: number;
  minor: number;
  patch: number;
}

export interface DockerCapabilities {
  versionDocker: Version;
  versionCompose: Version;
  healthcheckStartInterval: boolean;
  watchAvailable: boolean;
  buildAvailable: boolean;
  composeType?: "plugin" | "standalone";
}

function parseVersion(input: string): Version {
  const parts = input.trim().split(".", 3);

  const majorStr = parts[0] ?? "0";
  const minorStr = parts[1] ?? "0";
  const patchStr = parts[2] ?? "0";

  const major = Number.parseInt(
    majorStr.startsWith("v") ? majorStr.slice(1) : majorStr
  );
  const minor = Number.parseInt(minorStr);
  const patch = Number.parseInt(patchStr.split("-").at(0) ?? "0");

  return { major, minor, patch };
}

function compareVersion(a: Version, b: Version): number {
  if (a.major !== b.major) {
    return Math.sign(a.major - b.major);
  }

  if (a.minor !== b.minor) {
    return Math.sign(a.minor - b.minor);
  }

  return Math.sign(a.patch - b.patch);
}

export async function getDockerCapabilities(): Promise<DockerCapabilities> {
  let rawInfo: unknown | null = null;
  try {
    const { stdout } = await $(await getExecaOptions())`docker info -f json`;
    rawInfo = JSON.parse(stdout);
  } catch (error) {
    throw new Error("Docker not installed or not running: " + error);
  }

  const info = z
    .object({
      ServerVersion: z.string(),
      ClientInfo: z.object({
        Plugins: z.array(
          z.object({
            Name: z.string(),
            Version: z.string().optional(),
          })
        ),
      }),
    })
    .safeParse(rawInfo);

  if (!info.success || !info.data.ServerVersion) {
    throw new Error("Docker not running");
  }

  const composePlugin = info.data.ClientInfo.Plugins.find(
    (i): i is { Name: string; Version: string } =>
      i.Name === "compose" && i.Version != null
  );
  const buildxPlugin = info.data.ClientInfo.Plugins.find(
    (i): i is { Name: string; Version: string } =>
      i.Name === "buildx" && i.Version != null
  );

  let composeRes: Pick<DockerCapabilities, "versionCompose" | "composeType">;
  if (composePlugin != null) {
    composeRes = {
      composeType: "plugin",
      versionCompose: parseVersion(composePlugin.Version),
    };
  } else {
    try {
      const standalone = await $(
        await getExecaOptions()
      )`docker-compose --version --short`;
      composeRes = {
        composeType: "standalone",
        versionCompose: parseVersion(standalone.stdout),
      };
    } catch (error) {
      console.error(error);
      throw new Error("Docker Compose not installed");
    }
  }

  const versionDocker = parseVersion(info.data.ServerVersion);

  if (compareVersion(versionDocker, parseVersion("23.0.5")) < 0) {
    throw new Error("Please upgrade Docker to at least 23.0.5");
  }

  return {
    ...composeRes,
    healthcheckStartInterval:
      compareVersion(versionDocker, parseVersion("25.0.0")) >= 0,
    watchAvailable:
      compareVersion(composeRes.versionCompose, parseVersion("2.25.0")) >= 0,
    buildAvailable: buildxPlugin != null,
    versionDocker,
  };
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createCompose(
  capabilities: DockerCapabilities,
  options: {
    port?: number;
    postgresUri?: string;
    apiDef?: Record<string, any>;
  }
) {
  let includeDb = false;
  let postgresUri = options.postgresUri;

  if (!options.postgresUri) {
    includeDb = true;
    postgresUri = DEFAULT_POSTGRES_URI;
  } else {
    includeDb = false;
  }

  const compose: any = {
    services: {},
  };

  compose.services["langgraph-redis"] = { ...REDIS };

  if (includeDb) {
    compose.volumes = {
      "langgraph-data": { driver: "local" },
    };

    compose.services["langgraph-postgres"] = { ...DB };

    if (capabilities.healthcheckStartInterval) {
      compose.services["langgraph-postgres"].healthcheck.interval = "60s";
      compose.services["langgraph-postgres"].healthcheck.start_interval = "1s";
    } else {
      compose.services["langgraph-postgres"].healthcheck.interval = "5s";
    }
  }

  compose.services["langgraph-api"] = {
    ports: [options.port ? `${options.port}:8000` : "8000"],
    environment: {
      REDIS_URI: "redis://langgraph-redis:6379",
      POSTGRES_URI: postgresUri,
    },
    depends_on: {
      "langgraph-redis": { condition: "service_healthy" },
    },
  };

  if (includeDb) {
    compose.services["langgraph-api"].depends_on["langgraph-postgres"] = {
      condition: "service_healthy",
    };
  }

  if (capabilities.healthcheckStartInterval) {
    compose.services["langgraph-api"].healthcheck = {
      test: "python /api/healthcheck.py",
      interval: "60s",
      start_interval: "1s",
      start_period: "10s",
    };

    compose.services["langgraph-redis"].healthcheck.interval = "60s";
    compose.services["langgraph-redis"].healthcheck.start_interval = "1s";
  } else {
    compose.services["langgraph-redis"].healthcheck.interval = "5s";
  }

  // merge in with rest of the payload
  if (options.apiDef) {
    for (const key in options.apiDef) {
      const prevValue = compose.services["langgraph-api"][key];
      const newValue = options.apiDef[key];

      if (isPlainObject(prevValue) && isPlainObject(newValue)) {
        compose.services["langgraph-api"][key] = {
          ...prevValue,
          ...newValue,
        };
      } else {
        compose.services["langgraph-api"][key] = newValue;
      }
    }
  }

  return yaml.stringify(compose, { blockQuote: "literal" });
}
