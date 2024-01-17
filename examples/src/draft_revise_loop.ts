import { StringOutputParser } from "@langchain/core/output_parsers";
import { SystemMessagePromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { JsonOutputFunctionsParser } from "langchain/output_parsers";
import { Channel, Pregel } from "../../langgraph/src/pregel/index.js";

// prompts

const drafterPrompt = SystemMessagePromptTemplate.fromTemplate(
  `You are an expert on turtles, who likes to write in pirate-speak. You have been tasked by your editor with drafting a 100-word article answering the following question.
Question:\n\n{question}`
);

const reviserPrompt = SystemMessagePromptTemplate.fromTemplate(
  `You are an expert on turtles. You have been tasked by your editor with revising the following draft, which was written by a non-expert. You may follow the editor's notes or not, as you see fit.
Draft:\n\n{draft}
Editor's notes:\n\n{notes}`
);

const editorPrompt = SystemMessagePromptTemplate.fromTemplate(
  `You are an editor. You have been tasked with editing the following draft, which was written by a non-expert. Please accept the draft if it is good enough to publish, or send it for revision, along with your notes to guide the revision.
Draft:\n\n{draft}`
);

const editorFunctions = [
  {
    name: "revise",
    description: "Sends the draft for revision",
    parameters: {
      type: "object",
      properties: {
        notes: {
          type: "string",
          description: "The editor's notes to guide the revision."
        }
      }
    }
  },
  {
    name: "accept",
    description: "Accepts the draft",
    parameters: {
      type: "object",
      properties: { ready: { const: true } }
    }
  }
];

// llms

const gpt3 = new ChatOpenAI({
  modelName: "gpt-3.5-turbo"
});
const gpt4 = new ChatOpenAI({
  modelName: "gpt-4-1106-preview"
});

// chains

const drafterChain = drafterPrompt.pipe(gpt3).pipe(new StringOutputParser());

const editorChain = editorPrompt
  .pipe(
    gpt4.bind({
      functions: editorFunctions
    })
  )
  .pipe(
    new JsonOutputFunctionsParser({
      argsOnly: false
    })
  );

const reviserChain = reviserPrompt.pipe(gpt3).pipe(new StringOutputParser());

// application

const drafter = Channel.subscribeTo(["question"])
  .pipe(drafterChain)
  .pipe(Channel.writeTo("draft"));

const editor = Channel.subscribeTo(["draft"])
  .pipe(editorChain)
  .pipe(
    Channel.writeTo((x: any) =>
      x.name === "revise" ? x.arguments.notes : null
    )
  );

const reviser = Channel.subscribeTo(["notes"])
  .join(["question", "draft"])
  .pipe(reviserChain)
  .pipe(Channel.writeTo("draft"));

const draftReviseLoop = new Pregel({
  nodes: {
    drafter,
    editor,
    reviser
  },
  input: ["question"],
  output: "draft"
});

// run

console.log(await draftReviseLoop.invoke({ question: "What food do turtles eat?" }));

/**
Arr, me mateys! When it comes to grub, turtles be a peculiar lot. These seafarin' reptiles have a fancy fer slow-movin' nosh, mostly in the form of greens. We be talkin' 'bout seaweed, algae, and other tasty sea plants that tickle the taste buds o' our shelled mates. But turtles ain't just herbivores, ye see. Some sea turtles have a hankerin' fer squid, jellyfish, and even crabs. Land turtles, on the other hand, enjoy a heartier fare with worms, snails, and bugs in their bellies. So, ye scallywags, whether at sea or on land, turtles know how to fill their tummies just right!
 */