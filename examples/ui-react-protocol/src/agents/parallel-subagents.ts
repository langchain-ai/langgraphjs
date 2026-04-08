import { readFileSync } from "node:fs";

import { MemorySaver } from "@langchain/langgraph";
import { createQuickJSMiddleware } from "@langchain/quickjs";
import { createDeepAgent } from "deepagents";
import { tool } from "langchain";
import { z } from "zod/v4";

import { modelName } from "./shared";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type CustomerRecord = {
  index: number;
  customerId: string;
  firstName: string;
  lastName: string;
  company: string;
  city: string;
  country: string;
  email: string;
  subscriptionDate: string;
};

const parseCsvLine = (line: string) => {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
};

const loadFixtureCustomers = (): CustomerRecord[] => {
  const fixture = readFileSync(
    new URL("./fixtures/customers-100.csv", import.meta.url),
    "utf8"
  );
  const lines = fixture.trim().split(/\r?\n/);
  const [, ...rows] = lines;

  return rows.map((row) => {
    const cells = parseCsvLine(row);
    return {
      index: Number(cells[0]),
      customerId: cells[1],
      firstName: cells[2],
      lastName: cells[3],
      company: cells[4],
      city: cells[5],
      country: cells[6],
      email: cells[9],
      subscriptionDate: cells[10],
    };
  });
};

const fixtureCustomers = loadFixtureCustomers();

const loadCustomerFixture = tool(
  async ({ limit }: { limit?: number }) => {
    await sleep(120);
    const safeLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.min(fixtureCustomers.length, Math.floor(limit)))
        : fixtureCustomers.length;

    return JSON.stringify(
      {
        count: safeLimit,
        customers: fixtureCustomers.slice(0, safeLimit),
      },
      null,
      2
    );
  },
  {
    name: "load_customer_fixture",
    description:
      "Load customers from the bundled CSV fixture for fan-out benchmark tasks.",
    schema: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .max(fixtureCustomers.length)
        .optional()
        .describe("Optional number of customers to load from the fixture."),
    }),
  }
);

const poemValidationSchema = z.object({
  poem: z.string().describe("The draft poem to validate."),
  customerName: z.string().describe("Customer full name."),
  company: z.string().describe("Customer company."),
  city: z.string().describe("Customer city."),
  country: z.string().describe("Customer country."),
  attempt: z
    .number()
    .int()
    .nonnegative()
    .describe("Zero-based validation attempt number."),
});

const createFakePoemValidator = (
  name: string,
  focus: string,
  failureReasons: string[]
) =>
  tool(
    async ({
      poem,
      customerName,
      company,
      city,
      country,
      attempt,
    }: {
      poem: string;
      customerName: string;
      company: string;
      city: string;
      country: string;
      attempt: number;
    }) => {
      await sleep(120 + (attempt % 3) * 70);
      const passed = Math.random() < 0.3;
      const feedback = passed
        ? `Passed ${focus}. The poem feels ready for ${customerName}.`
        : failureReasons[(attempt - 1) % failureReasons.length];

      return JSON.stringify(
        {
          validator: name,
          focus,
          attempt,
          passed,
          feedback,
          customerName,
          context: `${company} · ${city}, ${country}`,
          poemPreview:
            poem.length > 90 ? `${poem.slice(0, 87).trimEnd()}...` : poem,
        },
        null,
        2
      );
    },
    {
      name,
      description: `Fake poem validator for ${focus}. Passes about 30% of the time.`,
      schema: poemValidationSchema,
    }
  );

const validatePoemPersonalization = createFakePoemValidator(
  "validate_poem_personalization",
  "personalization",
  [
    "Mention the customer more directly so the poem feels bespoke.",
    "Tie one image more clearly to the customer's company or location.",
    "The poem reads a little generic; anchor it in the customer's context.",
  ]
);

const validatePoemImagery = createFakePoemValidator(
  "validate_poem_imagery",
  "imagery",
  [
    "Add one more vivid image so the poem lands more memorably.",
    "The setting is clear, but the sensory detail still feels thin.",
    "Sharpen one line with a stronger visual or atmospheric detail.",
  ]
);

const validatePoemRhythm = createFakePoemValidator(
  "validate_poem_rhythm",
  "rhythm",
  [
    "Shorten one line so the cadence feels lighter.",
    "The phrasing is understandable, but the rhythm feels a bit flat.",
    "Adjust the line breaks so the ending lands more cleanly.",
  ]
);

const checkpointer = new MemorySaver();

export const agent = createDeepAgent({
  model: modelName,
  checkpointer,
  tools: [loadCustomerFixture],
  middleware: [
    createQuickJSMiddleware({
      ptc: ["task", "load_customer_fixture"],
      systemPrompt: `When the user asks for fan-out, load the bundled customer
fixture inside js_eval and then use Promise.all with tools.task so the work
runs in parallel. Prefer one customer per subagent instead of batching many
customers into a single task unless the user explicitly asks for batching.`,
    }),
  ],
  subagents: [
    {
      name: "parallel-worker",
      description:
        "Writes one tiny poem for one customer, then validates it repeatedly.",
      systemPrompt: `You are a focused customer poet.

Write exactly one short poem for the assigned customer.

Rules:
- Keep it to 3 short lines.
- Mention the customer's name.
- Mention either the company or the location.
- Keep it vivid but brief, with no JSON or bullet points.
- After drafting the poem, call exactly one validator at a time.
- Rotate across validate_poem_personalization, validate_poem_imagery, and
  validate_poem_rhythm.
- Stop once a validator returns passed=true, or after 6 validation attempts.
- Return only the final poem in your final answer.`,
      tools: [
        validatePoemPersonalization,
        validatePoemImagery,
        validatePoemRhythm,
      ],
    },
  ],
  systemPrompt: `You are the parallel subagent benchmark coordinator.

Your job is to stress-test hierarchical streaming by creating one short poem for
each customer in the bundled CSV fixture using many subagents in parallel.

Rules:
- When the user does not specify a count, default to all 100 customers.
- Use load_customer_fixture to get the customers you need.
- Use js_eval plus Promise.all to launch the worker tasks concurrently.
- Route every spawned task to the "parallel-worker" subagent type.
- Pass each task the customer's name, company, city, country, and email context.
- Produce one worker per customer so the UI shows a wide subagent list.
- Each worker should validate its poem until one fake validator passes, which
  should produce roughly 3 validation tool calls on average.
- After the workers finish, summarize the overall result in a short answer that
  mentions how many poems were created.`,
});
