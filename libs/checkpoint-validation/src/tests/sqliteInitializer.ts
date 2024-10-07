// eslint-disable-next-line import/no-extraneous-dependencies
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { CheckpointSaverTestInitializer } from "../types.js";

export const initializer: CheckpointSaverTestInitializer<SqliteSaver> = {
  saverName: "@langchain/langgraph-checkpoint-sqlite",

  async createSaver() {
    return SqliteSaver.fromConnString(":memory:");
  },

  destroySaver(saver) {
    saver.db.close();
  },
};

export default initializer;
