// eslint-disable-next-line import/no-extraneous-dependencies
import { SupabaseSaver } from "@langchain/langgraph-checkpoint-supabase";
import { createClient } from "@supabase/supabase-js";
import { CheckpointerTestInitializer } from "../types.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

export const initializer: CheckpointerTestInitializer<SupabaseSaver> = {
  checkpointerName: "@langchain/langgraph-checkpoint-supabase",

  async createCheckpointer() {
    const client = createClient(SUPABASE_URL, SUPABASE_KEY);
    return new SupabaseSaver(client);
  },

  async afterAll() {
    // const client = createClient(SUPABASE_URL, SUPABASE_KEY);
    // await client
    //   .from("langgraph_checkpoints")
    //   .delete()
    //   .neq("thread_id", "filter-needs-a-value")
    //   .throwOnError()
    // await client
    //   .from("langgraph_writes")
    //   .delete()
    //   .neq("thread_id", "filter-needs-a-value")
    //   .throwOnError()
  },

  async destroyCheckpointer() {
    const client = createClient(SUPABASE_URL, SUPABASE_KEY);
    await client
      .from("langgraph_checkpoints")
      .delete()
      .neq("thread_id", "filter-needs-a-value")
      .throwOnError()
    await client
      .from("langgraph_writes")
      .delete()
      .neq("thread_id", "filter-needs-a-value")
      .throwOnError()
  }
};

export default initializer;
