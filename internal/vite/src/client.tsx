import "./client.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./client.app.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
