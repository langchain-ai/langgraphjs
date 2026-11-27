const result = document.querySelector("#result");

try {
  const { Annotation, StateGraph, START, END, MemorySaver } =
    await import("@langchain/langgraph/web");
  const State = Annotation.Root({ value: Annotation() });
  const graph = new StateGraph(State)
    .addNode("double", ({ value }) => ({ value: value * 2 }))
    .addEdge(START, "double")
    .addEdge("double", END)
    .compile({ checkpointer: new MemorySaver() });

  const config = { configurable: { thread_id: "invoke-demo" } };
  const output = await graph.invoke({ value: 21 }, config);
  const checkpoint = await graph.getState(config);

  const stream = [];
  for await (const state of await graph.stream(
    { value: 2 },
    { configurable: { thread_id: "stream-demo" }, streamMode: "values" }
  )) {
    stream.push(state.value);
  }

  result.textContent = JSON.stringify(
    { result: output.value, checkpoint: checkpoint.values.value, stream },
    null,
    2
  );
  result.dataset.status = "complete";
} catch (error) {
  result.textContent = error instanceof Error ? error.message : String(error);
  result.dataset.status = "error";
}
