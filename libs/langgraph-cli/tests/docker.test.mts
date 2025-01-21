import { expect, it } from "vitest";
import {
  createCompose,
  DEFAULT_POSTGRES_URI,
  type DockerCapabilities,
} from "../src/docker/compose.mjs";
import dedent from "dedent";

const DEFAULT_DOCKER_CAPABILITIES: DockerCapabilities = {
  versionDocker: { major: 26, minor: 1, patch: 1 },
  versionCompose: { major: 2, minor: 27, patch: 0 },
  healthcheckStartInterval: false,
  watchAvailable: true,
  buildAvailable: true,
};

it("compose with custom db", () => {
  const port = 8123;
  const postgresUri = "custom_postgres_uri";

  expect(createCompose(DEFAULT_DOCKER_CAPABILITIES, { port, postgresUri }))
    .toEqual(dedent`
      services:
        langgraph-redis:
          image: redis:6
          healthcheck:
            test: redis-cli ping
            start_period: 10s
            timeout: 1s
            retries: 5
            interval: 5s
        langgraph-api:
          ports:
            - ${port}:8000
          environment:
            REDIS_URI: redis://langgraph-redis:6379
            POSTGRES_URI: ${postgresUri}
          depends_on:
            langgraph-redis:
              condition: service_healthy\n
    `);
});

it("compose with custom db and healthcheck", () => {
  const port = 8123;
  const postgresUri = "custom_postgres_uri";

  expect(
    createCompose(
      { ...DEFAULT_DOCKER_CAPABILITIES, healthcheckStartInterval: true },
      { port, postgresUri }
    )
  ).toEqual(dedent`
      services:
        langgraph-redis:
          image: redis:6
          healthcheck:
            test: redis-cli ping
            start_period: 10s
            timeout: 1s
            retries: 5
            interval: 60s
            start_interval: 1s
        langgraph-api:
          ports:
            - ${port}:8000
          environment:
            REDIS_URI: redis://langgraph-redis:6379
            POSTGRES_URI: ${postgresUri}
          depends_on:
            langgraph-redis:
              condition: service_healthy
          healthcheck:
            test: python /api/healthcheck.py
            interval: 60s
            start_interval: 1s
            start_period: 10s\n
    `);
});

it("compose with default db", () => {
  const port = 8123;

  expect(createCompose(DEFAULT_DOCKER_CAPABILITIES, { port })).toEqual(dedent`
      services:
        langgraph-redis:
          image: redis:6
          healthcheck:
            test: redis-cli ping
            start_period: 10s
            timeout: 1s
            retries: 5
            interval: 5s
            start_interval: 1s
        langgraph-postgres:
          image: pgvector/pgvector:pg16
          expose:
            - "5432"
          command:
            - postgres
            - -c
            - shared_preload_libraries=vector
          environment:
            POSTGRES_DB: postgres
            POSTGRES_USER: postgres
            POSTGRES_PASSWORD: postgres
          volumes:
            - langgraph-data:/var/lib/postgresql/data
          healthcheck:
            test: pg_isready -U postgres
            start_period: 10s
            timeout: 1s
            retries: 5
            interval: 5s
        langgraph-api:
          ports:
            - ${port}:8000
          environment:
            REDIS_URI: redis://langgraph-redis:6379
            POSTGRES_URI: ${DEFAULT_POSTGRES_URI}
          depends_on:
            langgraph-redis:
              condition: service_healthy
            langgraph-postgres:
              condition: service_healthy
      volumes:
        langgraph-data:
          driver: local\n
    `);
});
