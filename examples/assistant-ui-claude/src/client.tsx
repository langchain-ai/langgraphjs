import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./globals.css";
import { MyAssistant } from "./components/my-assistant";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MyAssistant />
  </StrictMode>,
);
