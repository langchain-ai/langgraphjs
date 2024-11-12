import { FirebaseSaver } from "@langchain/langgraph-checkpoint-firebase";
import { initializeApp} from "firebase/app";
import type { CheckpointerTestInitializer } from "../types.js";

import { GenericContainer, StartedTestContainer } from "testcontainers";
import { getDatabase} from "firebase/database";

const FIREBASE_PORT = 9000;

class FirebaseTestContainer {
  container?: StartedTestContainer;

  async start() {
    this.container = await new GenericContainer("firebase/firebase-tools")
      .withExposedPorts(FIREBASE_PORT)
      .withCmd([
        "emulators:start",
        "--only",
        "database",
        "--project",
        "test-project",
      ])
      .start();

    return this.getDatabaseUrl();
  }

  async stop() {
    if (this.container) {
      await this.container.stop();
    }
  }

  getDatabaseUrl() {
    if (!this.container) {
      throw new Error("Firebase container has not been started.");
    }

    const port = this.container.getMappedPort(FIREBASE_PORT);
    return `http://localhost:${port}`;
  }
}



const testContainer = new FirebaseTestContainer();

export const initializer: CheckpointerTestInitializer<FirebaseSaver> = {
  checkpointerName: "@langchain/langgraph-checkpoint-firebase",

  async beforeAll() {
    const databaseUrl = await testContainer.start();
    databaseUrl.getMappedPort()


    // Initialize Firebase SDK pointing to the emulator
    initializeApp({
      apiKey: "fake-api-key", // Firebase requires a fake API key for emulator use
      authDomain: "localhost",
      projectId: "test-project", // Match the emulator's projectId
      databaseURL: ,
    });

    console.log(`Firebase Emulator running at ${databaseUrl}`);
  },

  beforeAllTimeout: 300_000, // five minutes to set up Firebase emulator

  async createCheckpointer() {
    const database = getDatabase();
    return new FirebaseSaver(database);
  },

  async afterAll() {
    await testContainer.stop();
  },
};

export default initializer;
