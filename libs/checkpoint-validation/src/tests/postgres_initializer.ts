/* eslint-disable import/no-extraneous-dependencies */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

import pg from "pg";

import type { CheckpointerTestInitializer } from "../types.js";

const dbName = "test_db";

const container = new PostgreSqlContainer("postgres:16.2")
  .withDatabase("postgres")
  .withUsername("postgres")
  .withPassword("postgres");

let startedContainer: StartedPostgreSqlContainer;
let client: pg.Pool | undefined;

export const initializer: CheckpointerTestInitializer<PostgresSaver> = {
  checkpointerName: "@langchain/langgraph-checkpoint-postgres",

  async beforeAll() {
    startedContainer = await container.start();
  },

  beforeAllTimeout: 300_000, // five minutes, to pull docker container

  async afterAll() {
    await startedContainer.stop();
  },

  async createCheckpointer() {
    client = new pg.Pool({
      connectionString: startedContainer.getConnectionUri(),
    });

    await client?.query(`CREATE DATABASE ${dbName}`);

    const url = new URL("", "postgres://");
    url.hostname = startedContainer.getHost();
    url.port = startedContainer.getPort().toString();
    url.pathname = dbName;
    url.username = startedContainer.getUsername();
    url.password = startedContainer.getPassword();

    const checkpointer = PostgresSaver.fromConnString(url.toString());
    await checkpointer.setup();
    return checkpointer;
  },

  async destroyCheckpointer(checkpointer: PostgresSaver) {
    await checkpointer.end();
    await client?.query(`DROP DATABASE ${dbName}`);
    await client?.end();
  },
};

export default initializer;
