/* eslint-disable no-process-env */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { runPregelTests } from "./pregel.test.js";

const { Pool } = pg;

const checkpointers: PostgresSaver[] = [];

runPregelTests(
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_POSTGRES_URL,
    });

    // Generate a unique database name
    const dbName = `lg_test_db_${Date.now()}_${Math.floor(
      Math.random() * 1000
    )}`;

    try {
      // Create a new database
      await pool.query(`CREATE DATABASE ${dbName}`);

      // Connect to the new database
      const dbConnectionString = `${process.env.TEST_POSTGRES_URL?.split("/")
        .slice(0, -1)
        .join("/")}/${dbName}`;
      const checkpointer = PostgresSaver.fromConnString(dbConnectionString);
      await checkpointer.setup();
      checkpointers.push(checkpointer);
      return checkpointer;
    } finally {
      await pool.end();
    }
  },
  async () => {
    await Promise.all(checkpointers.map((checkpointer) => checkpointer.end()));
    // Drop all test databases
    const pool = new Pool({
      connectionString: process.env.TEST_POSTGRES_URL,
    });

    try {
      const result = await pool.query(`
      SELECT datname FROM pg_database
      WHERE datname LIKE 'lg_test_db_%'
    `);

      for (const row of result.rows) {
        const dbName = row.datname;
        await pool.query(`DROP DATABASE ${dbName}`);
        console.log(`Dropped database: ${dbName}`);
      }
    } finally {
      await pool.end();
    }
  }
);
