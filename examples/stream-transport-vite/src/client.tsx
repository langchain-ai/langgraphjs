import "./client.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import {
  useStream,
  FetchStreamTransport,
} from "@langchain/langgraph-sdk/react";

export function App() {
  const stream = useStream({
    transport: new FetchStreamTransport({
      apiUrl: "/api/stream",
    }),
  });

  return (
    <div className="max-w-xl mx-auto">
      <div className="flex flex-col gap-2">
        {stream.messages.map((message) => (
          <div key={message.id} className="whitespace-pre-wrap">
            {message.content as string}
          </div>
        ))}
      </div>
      <form
        className="grid grid-cols-[1fr_auto] gap-2"
        onSubmit={(e) => {
          e.preventDefault();

          const form = e.target as HTMLFormElement;
          const formData = new FormData(form);
          const content = formData.get("content") as string;

          form.reset();
          stream.submit({ messages: [{ content, type: "human" }] });
        }}
      >
        <textarea
          name="content"
          className="field-sizing-content"
          onKeyDown={(e) => {
            const target = e.target as HTMLTextAreaElement;

            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              target.form?.requestSubmit();
            }
          }}
        />
        <button type="submit">Submit</button>
      </form>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
