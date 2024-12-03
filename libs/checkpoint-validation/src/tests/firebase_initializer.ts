import { FirebaseSaver } from "@langchain/langgraph-checkpoint-firebase";
import { initializeApp } from "firebase/app";
import { getDatabase, Database } from "firebase/database";
import type { CheckpointerTestInitializer } from "../types.js";

let database: Database;

export const initializer: CheckpointerTestInitializer<FirebaseSaver> = {
  checkpointerName: "@langchain/langgraph-checkpoint-firebase",

  async beforeAll() {
    // Ensure the Firebase Emulator is running locally
    const firebaseConfig = {
      apiKey: "test-api-key",
      authDomain: "localhost",
      projectId: "test-project",
      databaseURL: process.env.FIREBASEURL || "http://localhost:9000", // Use emulator URL
    };
    process.env.FIREBASE_URL = process.env.FIREBASEURL || "http://localhost:9000"
    // Initialize Firebase app
    const app = initializeApp(firebaseConfig);

    // Initialize Firebase Realtime Database
    database = getDatabase(app);

    console.log("Connected to Firebase Realtime Database Emulator");
  },

  beforeAllTimeout: 300_000, // Allow up to 5 minutes for emulator setup

  async createCheckpointer() {
    // Create a new instance of FirebaseSaver with the initialized database
    return new FirebaseSaver(database);
  },

  async afterAll() {
    console.log("Cleaning up Firebase Realtime Database Emulator");
    // Optionally, you can implement cleanup logic here if necessary
  },
};

export default initializer;
