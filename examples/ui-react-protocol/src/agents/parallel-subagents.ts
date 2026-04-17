import { readFileSync } from "node:fs";

import { MemorySaver } from "@langchain/langgraph";
import { createQuickJSMiddleware } from "@langchain/quickjs";
import { createDeepAgent, StoreBackend } from "deepagents";
import { tool, createMiddleware } from "langchain";
import { z } from "zod/v4";

import { modelName } from "./shared";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const mountedCsvPath = "/fixtures/customers-100.csv";
const fixtureCsv = readFileSync(
  new URL("./fixtures/customers-100.csv", import.meta.url),
  "utf8"
);
const fixtureCustomerCount = Math.max(
  0,
  fixtureCsv.trim().split(/\r?\n/).length - 1
);

const poemValidationSchema = z.object({
  poem: z.string().default("").describe("The draft poem to validate."),
  customerName: z.string().default("").describe("Customer full name."),
  company: z.string().default("").describe("Customer company."),
  city: z.string().default("").describe("Customer city."),
  country: z.string().default("").describe("Customer country."),
  attempt: z
    .number()
    .int()
    .nonnegative()
    .default(0)
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
      const hasRequiredInput =
        poem.trim().length > 0 &&
        customerName.trim().length > 0 &&
        company.trim().length > 0 &&
        city.trim().length > 0 &&
        country.trim().length > 0;
      const passed = hasRequiredInput && Math.random() < 0.3;
      const feedback = passed
        ? `Passed ${focus}. The poem feels ready for ${customerName}.`
        : hasRequiredInput
          ? failureReasons[attempt % failureReasons.length]
          : `Missing validator input. Call ${name} again with poem, customerName, company, city, country, and attempt.`;

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

export async function agent() {
  const backend = new StoreBackend({ fileFormat: "v2" });
  return createDeepAgent({
    model: modelName,
    backend,
    checkpointer,
    middleware: [
      // @ts-ignore
      createQuickJSMiddleware({
        backend,
        ptc: ["task"],
      }),
      // @ts-ignore
      createMiddleware({
        name: "csv-fixture",
        beforeAgent: async (runtime) => {
          await backend.write(mountedCsvPath, fixtureCsv);
          return runtime;
        },
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
- Every validator call must include poem, customerName, company, city, country,
  and attempt.
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

Important: Use js_eval exactly once per request to do the whole workflow end to
end. Inside that single script, call await readFile("${mountedCsvPath}") to
load the CSV, parse it in JavaScript, select the requested customers, and
launch all worker tasks with Promise.all.

Never paste, inline, or reconstruct the CSV contents inside the script. Always
read the fixture from ${mountedCsvPath} at runtime instead of copying it into a
string literal.

Inside QuickJS, launch workers with tools.task(...). The task calls should use
the documented shape with subagentType: "parallel-worker".

Rules:
- When the user does not specify a count, default to all ${fixtureCustomerCount}
  customers.
- Perform the CSV read, parse, customer selection, and Promise.all fan-out
  inside one js_eval call.
- Do not define reusable REPL helpers first, and do not split the workflow
  across multiple js_eval calls unless the first call fails.
- Do not launch workers sequentially. Map over all selected customers and await
  a single Promise.all call for the full batch.
- Route every spawned task with subagentType: "parallel-worker".
- Pass each task the customer's name, company, city, country, and email context.
- Produce one worker per customer so the UI shows a wide subagent list.
- Each worker should validate its poem until one fake validator passes, which
  should produce roughly 3 validation tool calls on average.
- After the workers finish, summarize the overall result in a short answer that
  mentions how many poems were created.`,
  });
}