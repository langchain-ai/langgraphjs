import { it, expect } from "@jest/globals";

/*
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

# useful to generate SQL query
model_low_temp = ChatOpenAI(temperature=0.1)
# useful to generate natural language outputs
model_high_temp = ChatOpenAI(temperature=0.7)

class State(TypedDict):
    # to track conversation history
    messages: Annotated[list, add_messages]
    # input
    user_query: str
    # output
    sql_query: str
    sql_explanation: str

class Input(TypedDict):
    user_query: str

class Output(TypedDict):
    sql_query: str
    sql_explanation: str

generate_prompt = SystemMessage(
    "You are a helpful data analyst, who generates SQL queries for users based on their questions."
)

def generate_sql(state: State) -> State:
    user_message = HumanMessage(state["user_query"])
    messages = [generate_prompt, *state["messages"], user_message]
    res = model_low_temp.invoke(messages)
    return {
        "sql_query": res.content,
        # update conversation history
        "messages": [user_message, res],
    }

explain_prompt = SystemMessage(
    "You are a helpful data analyst, who explains SQL queries to users."
)

def explain_sql(state: State) -> State:
    messages = [
        explain_prompt,
        # contains the user's query and the SQL query from the previous step
        *state["messages"],
    ]
    res = model_high_temp.invoke(messages)
    return {
        "sql_explanation": res.content,
        # update conversation history
        "messages": res,
    }

builder = StateGraph(State, input=Input, output=Output)
builder.add_node("generate_sql", generate_sql)
builder.add_node("explain_sql", explain_sql)
builder.add_edge(START, "generate_sql")
builder.add_edge("generate_sql", "explain_sql")
builder.add_edge("explain_sql", END)

graph = builder.compile()
*/
import {
  AIMessage,
  SystemMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { DocumentInterface, Document } from "@langchain/core/documents";
import { DuckDuckGoSearch } from "@langchain/community/tools/duckduckgo_search";
import { Calculator } from "@langchain/community/tools/calculator";
import { ToolNode, toolsCondition } from "../prebuilt/index.js";
import {
  StateGraph,
  Annotation,
  messagesStateReducer,
  START,
  END,
} from "../web.js";

it("chain arch", () => {
  // useful to generate SQL query
  const modelLowTemp = new ChatOpenAI({ temperature: 0.1 });
  // useful to generate natural language outputs
  const modelHighTemp = new ChatOpenAI({ temperature: 0.7 });

  const annotation = Annotation.Root({
    messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
    user_query: Annotation<string>(),
    sql_query: Annotation<string>(),
    sql_explanation: Annotation<string>(),
  });

  const generatePrompt = new SystemMessage(
    "You are a helpful data analyst, who generates SQL queries for users based on their questions."
  );

  async function generateSql(state: typeof annotation.State) {
    const userMessage = new HumanMessage(state.user_query);
    const messages = [generatePrompt, ...state.messages, userMessage];
    const res = await modelLowTemp.invoke(messages);
    return {
      sql_query: res.content as string,
      // update conversation history
      messages: [userMessage, res],
    };
  }

  const explainPrompt = new SystemMessage(
    "You are a helpful data analyst, who explains SQL queries to users."
  );

  async function explainSql(state: typeof annotation.State) {
    const messages = [explainPrompt, ...state.messages];
    const res = await modelHighTemp.invoke(messages);
    return {
      sql_explanation: res.content as string,
      // update conversation history
      messages: res,
    };
  }

  const builder = new StateGraph(annotation)
    .addNode("generate_sql", generateSql)
    .addNode("explain_sql", explainSql)
    .addEdge(START, "generate_sql")
    .addEdge("generate_sql", "explain_sql")
    .addEdge("explain_sql", END);

  const graph = builder.compile();

  expect(graph.getGraph().drawMermaid()).toMatchSnapshot();
});

/*
from typing import Annotated, Literal, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.vectorstores.in_memory import InMemoryVectorStore
from langchain_openai import ChatOpenAI, OpenAIEmbeddings

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

embeddings = OpenAIEmbeddings()
# useful to generate SQL query
model_low_temp = ChatOpenAI(temperature=0.1)
# useful to generate natural language outputs
model_high_temp = ChatOpenAI(temperature=0.7)

class State(TypedDict):
    # to track conversation history
    messages: Annotated[list, add_messages]
    # input
    user_query: str
    # output
    domain: Literal["records", "insurance"]
    documents: str
    answer: str

class Input(TypedDict):
    user_query: str

class Output(TypedDict):
    documents: str
    answer: str

# refer to chapter 2 on how to fill a vector store with documents
medical_records_store = InMemoryVectorStore.from_documents([], embeddings)
medical_records_retriever = medical_records_store.as_retriever()

insurance_faqs_store = InMemoryVectorStore.from_documents([], embeddings)
insurance_faqs_retriever = insurance_faqs_store.as_retriever()

router_prompt = SystemMessage(
    """You need to decide which domain to route the user query to. You have two domains to choose from:
- records: contains medical records of the patient, such as diagnosis, treatment, and prescriptions.
- insurance: contains frequently asked questions about insurance policies, claims, and coverage.

Output only the domain name."""
)

def router_node(state: State) -> State:
    user_message = HumanMessage(state["user_query"])
    messages = [router_prompt, *state["messages"], user_message]
    res = model_low_temp.invoke(messages)
    return {
        "domain": res.content,
        # update conversation history
        "messages": [user_message, res],
    }

def pick_retriever(
    state: State,
) -> Literal["retrieve_medical_records", "retrieve_insurance_faqs"]:
    if state["domain"] == "records":
        return "retrieve_medical_records"
    else:
        return "retrieve_insurance_faqs"

def retrieve_medical_records(state: State) -> State:
    documents = medical_records_retriever.invoke(state["user_query"])
    return {
        "documents": documents,
    }

def retrieve_insurance_faqs(state: State) -> State:
    documents = insurance_faqs_retriever.invoke(state["user_query"])
    return {
        "documents": documents,
    }

medical_records_prompt = SystemMessage(
    "You are a helpful medical chatbot, who answers questions based on the patient's medical records, such as diagnosis, treatment, and prescriptions."
)

insurance_faqs_prompt = SystemMessage(
    "You are a helpful medical insurance chatbot, who answers frequently asked questions about insurance policies, claims, and coverage."
)

def generate_answer(state: State) -> State:
    if state["domain"] == "records":
        prompt = medical_records_prompt
    else:
        prompt = insurance_faqs_prompt
    messages = [
        prompt,
        *state["messages"],
        HumanMessage(f"Documents: {state["documents"]}"),
    ]
    res = model_high_temp.invoke(messages)
    return {
        "answer": res.content,
        # update conversation history
        "messages": res,
    }

builder = StateGraph(State, input=Input, output=Output)
builder.add_node("router", router_node)
builder.add_node("retrieve_medical_records", retrieve_medical_records)
builder.add_node("retrieve_insurance_faqs", retrieve_insurance_faqs)
builder.add_node("generate_answer", generate_answer)
builder.add_edge(START, "router")
builder.add_conditional_edges("router", pick_retriever)
builder.add_edge("retrieve_medical_records", "generate_answer")
builder.add_edge("retrieve_insurance_faqs", "generate_answer")
builder.add_edge("generate_answer", END)

graph = builder.compile()

assert graph.get_graph().draw_mermaid() == snapshot
*/
it("router arch", async () => {
  const embeddings = new OpenAIEmbeddings();
  // useful to generate SQL query
  const modelLowTemp = new ChatOpenAI({ temperature: 0.1 });
  // useful to generate natural language outputs
  const modelHighTemp = new ChatOpenAI({ temperature: 0.7 });

  const annotation = Annotation.Root({
    messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
    user_query: Annotation<string>,
    domain: Annotation<"records" | "insurance">,
    documents: Annotation<DocumentInterface[]>,
    answer: Annotation<string>,
  });

  // refer to chapter 2 on how to fill a vector store with documents
  const medicalRecordsStore = await MemoryVectorStore.fromDocuments(
    [],
    embeddings
  );
  const medicalRecordsRetriever = medicalRecordsStore.asRetriever();

  const insuranceFaqsStore = await MemoryVectorStore.fromDocuments(
    [],
    embeddings
  );
  const insuranceFaqsRetriever = insuranceFaqsStore.asRetriever();

  const routerPrompt = new SystemMessage(
    `You need to decide which domain to route the user query to. You have two domains to choose from:
- records: contains medical records of the patient, such as diagnosis, treatment, and prescriptions.
- insurance: contains frequently asked questions about insurance policies, claims, and coverage.

Output only the domain name.`
  );

  async function routerNode(state: typeof annotation.State) {
    const userMessage = new HumanMessage(state.user_query);
    const messages = [routerPrompt, ...state.messages, userMessage];
    const res = await modelLowTemp.invoke(messages);
    return {
      domain: res.content as "records" | "insurance",
      // update conversation history
      messages: [userMessage, res],
    };
  }

  function pickRetriever(state: typeof annotation.State) {
    if (state.domain === "records") {
      return "retrieve_medical_records";
    } else {
      return "retrieve_insurance_faqs";
    }
  }

  async function retrieveMedicalRecords(state: typeof annotation.State) {
    const documents = await medicalRecordsRetriever.invoke(state.user_query);
    return {
      documents,
    };
  }

  async function retrieveInsuranceFaqs(state: typeof annotation.State) {
    const documents = await insuranceFaqsRetriever.invoke(state.user_query);
    return {
      documents,
    };
  }

  const medicalRecordsPrompt = new SystemMessage(
    "You are a helpful medical chatbot, who answers questions based on the patient's medical records, such as diagnosis, treatment, and prescriptions."
  );

  const insuranceFaqsPrompt = new SystemMessage(
    "You are a helpful medical insurance chatbot, who answers frequently asked questions about insurance policies, claims, and coverage."
  );

  async function generateAnswer(state: typeof annotation.State) {
    const prompt =
      state.domain === "records" ? medicalRecordsPrompt : insuranceFaqsPrompt;
    const messages = [
      prompt,
      ...state.messages,
      new HumanMessage(`Documents: ${state.documents}`),
    ];
    const res = await modelHighTemp.invoke(messages);
    return {
      answer: res.content as string,
      // update conversation history
      messages: res,
    };
  }

  const builder = new StateGraph(annotation)
    .addNode("router", routerNode)
    .addNode("retrieve_medical_records", retrieveMedicalRecords)
    .addNode("retrieve_insurance_faqs", retrieveInsuranceFaqs)
    .addNode("generate_answer", generateAnswer)
    .addEdge(START, "router")
    .addConditionalEdges("router", pickRetriever)
    .addEdge("retrieve_medical_records", "generate_answer")
    .addEdge("retrieve_insurance_faqs", "generate_answer")
    .addEdge("generate_answer", END);

  const graph = builder.compile();

  expect(graph.getGraph().drawMermaid()).toMatchSnapshot();
});

/*
from typing import Annotated, TypedDict

from langchain_community.tools import DuckDuckGoSearchRun
from langchain_openai import ChatOpenAI

from langgraph.graph import START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition

search = DuckDuckGoSearchRun()
tools = [search]
model = ChatOpenAI(temperature=0.1).bind_tools(tools)

class State(TypedDict):
    messages: Annotated[list, add_messages]

def model_node(state: State) -> State:
    res = model.invoke(state["messages"])
    return {"messages": res}

builder = StateGraph(State)
builder.add_node("model", model_node)
builder.add_node("tools", ToolNode(tools))
builder.add_edge(START, "model")
builder.add_conditional_edges("model", tools_condition)
builder.add_edge("tools", "model")

graph = builder.compile()

assert graph.get_graph().draw_mermaid() == snapshot
*/

it("agent arch", () => {
  const search = new DuckDuckGoSearch();
  const calculator = new Calculator();
  const tools = [search, calculator];
  const model = new ChatOpenAI({ temperature: 0.1 }).bindTools(tools);

  const annotation = Annotation.Root({
    messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
  });

  async function modelNode(state: typeof annotation.State) {
    const res = await model.invoke(state.messages);
    return { messages: res };
  }

  const builder = new StateGraph(annotation)
    .addNode("model", modelNode)
    .addNode("tools", new ToolNode<typeof annotation.State>(tools))
    .addEdge(START, "model")
    .addConditionalEdges("model", toolsCondition)
    .addEdge("tools", "model");

  const graph = builder.compile();
});

it("agent arch always tool", () => {
  const search = new DuckDuckGoSearch();
  const calculator = new Calculator();
  const tools = [search, calculator];
  const model = new ChatOpenAI({ temperature: 0.1 }).bindTools(tools);

  const annotation = Annotation.Root({
    messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
  });

  async function firstModelNode(state: typeof annotation.State) {
    const query = state.messages[state.messages.length - 1].content;
    const searchToolCall = {
      name: "duckduckgo_search",
      args: { query },
      id: Math.random().toString(),
    };
    return {
      messages: [new AIMessage({ content: "", tool_calls: [searchToolCall] })],
    };
  }

  async function modelNode(state: typeof annotation.State) {
    const res = await model.invoke(state.messages);
    return { messages: res };
  }

  const builder = new StateGraph(annotation)
    .addNode("first_model", firstModelNode)
    .addNode("model", modelNode)
    .addNode("tools", new ToolNode<typeof annotation.State>(tools))
    .addEdge(START, "first_model")
    .addEdge("first_model", "tools")
    .addEdge("tools", "model")
    .addConditionalEdges("model", toolsCondition);

  const graph = builder.compile();
});

/*
import ast
from typing import Annotated, TypedDict

from langchain_community.tools import DuckDuckGoSearchRun
from langchain_core.documents import Document
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from langchain_core.vectorstores.in_memory import InMemoryVectorStore
from langchain_openai import ChatOpenAI, OpenAIEmbeddings

from langgraph.graph import START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition

@tool
def calculator(query: str) -> str:
    """A simple calculator tool. Input should be a mathematical expression."""
    return ast.literal_eval(query)

search = DuckDuckGoSearchRun()
tools = [search, calculator]
embeddings = OpenAIEmbeddings()
model = ChatOpenAI(temperature=0.1)
tools_retriever = InMemoryVectorStore.from_documents(
    [Document(tool.description, metadata={"name": tool.name}) for tool in tools],
    embeddings,
).as_retriever()

class State(TypedDict):
    messages: Annotated[list, add_messages]
    selected_tools: list[str]

def model_node(state: State) -> State:
    selected_tools = [
        tool for tool in tools if tool.name in state["selected_tools"]
    ]
    res = model.bind_tools(selected_tools).invoke(state["messages"])
    return {"messages": res}

def select_tools(state: State) -> State:
    query = state["messages"][-1].content
    tool_docs = tools_retriever.invoke(query)
    return {"selected_tools": [doc.metadata["name"] for doc in tool_docs]}

builder = StateGraph(State)
builder.add_node("select_tools", select_tools)
builder.add_node("model", model_node)
builder.add_node("tools", ToolNode(tools))
builder.add_edge(START, "select_tools")
builder.add_edge("select_tools", "model")
builder.add_conditional_edges("model", tools_condition)
builder.add_edge("tools", "model")

graph = builder.compile()
*/
it("agent arch with tools", async () => {
  const search = new DuckDuckGoSearch();
  const calculator = new Calculator();
  const tools = [search, calculator];
  const embeddings = new OpenAIEmbeddings();
  const model = new ChatOpenAI({ temperature: 0.1 });
  const toolsStore = await MemoryVectorStore.fromDocuments(
    tools.map(
      (tool) =>
        new Document({
          pageContent: tool.description,
          metadata: { name: tool.constructor.name },
        })
    ),
    embeddings
  );
  const toolsRetriever = toolsStore.asRetriever();

  const annotation = Annotation.Root({
    messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
    selected_tools: Annotation<string[]>(),
  });

  async function modelNode(state: typeof annotation.State) {
    const selectedTools = tools.filter((tool) =>
      state.selected_tools.includes(tool.constructor.name)
    );
    const res = await model.bindTools(selectedTools).invoke(state.messages);
    return { messages: res };
  }

  async function selectTools(state: typeof annotation.State) {
    const query = state.messages[state.messages.length - 1].content;
    const toolDocs = await toolsRetriever.invoke(query as string);
    return {
      selected_tools: toolDocs.map((doc) => doc.metadata.name),
    };
  }

  const builder = new StateGraph(annotation)
    .addNode("select_tools", selectTools)
    .addNode("model", modelNode)
    .addNode("tools", new ToolNode<typeof annotation.State>(tools))
    .addEdge(START, "select_tools")
    .addEdge("select_tools", "model")
    .addConditionalEdges("model", toolsCondition)
    .addEdge("tools", "model");

  const graph = builder.compile();
});
