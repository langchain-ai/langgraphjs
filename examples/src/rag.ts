import { OpenAIEmbeddings, ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage, FunctionMessage } from "@langchain/core/messages";
import { PromptTemplate } from "@langchain/core/prompts";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { Channel, Pregel } from "../../langgraph/src/pregel/index.js";
import { Topic } from "../../langgraph/src/channels/index.js";

const texts: string[] = ["harrison went to kensho"];
const embeddings = new OpenAIEmbeddings();
/**
 * Install the `faiss-node` package.
 */
const db = await FaissStore.fromTexts(texts, [], embeddings);

const retriever = db.asRetriever();

const prompt = PromptTemplate.fromTemplate(
  `Answer the question "{question}" based on the following context: {context}`
);

const model = new ChatOpenAI();

const chain = Channel.subscribeTo(["question"])
  .pipe({
    context: (x: any) =>
      x.question
        .pipe(
          Channel.writeTo(
            (input: string) =>
              new AIMessage("", {
                function_call: "retrieval",
                arguments: { question: input }
              })
          )
        )
        .pipe(retriever)
        .pipe(
          Channel.writeTo((documents: any) =>
            new FunctionMessage({
              name: "retrieval",
              content: documents
            })
          )
        ),
    question: (x: any) => x.question
  })
  .pipe(prompt)
  .pipe(model)
  .pipe(Channel.writeTo((message: any) => [message]));

const app = new Pregel({
  nodes: { chain },
  channels: { messages: new Topic<BaseMessage>() },
  input: ["question"],
  output: ["messages"]
});

for await (const s of await app.stream({ question: "where did harrison go" })) {
  console.log(s);
}
