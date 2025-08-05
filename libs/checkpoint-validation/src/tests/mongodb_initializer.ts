/* eslint-disable import/no-extraneous-dependencies */
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import {
  MongoDBContainer,
  type StartedMongoDBContainer,
} from "@testcontainers/mongodb";

import { MongoClient } from "mongodb";
import type { CheckpointerTestInitializer } from "../types.js";

const dbName = "test_db";

const container = new MongoDBContainer("mongo:6.0.1");

let startedContainer: StartedMongoDBContainer;
let client: MongoClient | undefined;

export const initializer: CheckpointerTestInitializer<MongoDBSaver> = {
  checkpointerName: "@langchain/langgraph-checkpoint-mongodb",

  async beforeAll() {
    startedContainer = await container.start();
    const connectionString = `mongodb://127.0.0.1:${startedContainer.getMappedPort(
      27017
    )}/${dbName}?directConnection=true`;
    client = new MongoClient(connectionString);
  },

  beforeAllTimeout: 300_000, // five minutes, to pull docker container

  async createCheckpointer() {
    // ensure fresh database for each test
    const db = await client!.db(dbName);
    await db.dropDatabase();
    await client!.db(dbName);

    return new MongoDBSaver({
      client: client!,
    });
  },

  async afterAll() {
    await client?.close();
    await startedContainer.stop();
  },
};

export default initializer;
