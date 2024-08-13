import { fetch, Agent } from "undici";

const resp = await fetch("http://checkpointer/run", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    input: {
      messages: [],
    },
  }),
  dispatcher: new Agent({ connect: { socketPath: "./checkpointer.sock" } }),
});

console.log(await resp.text());
