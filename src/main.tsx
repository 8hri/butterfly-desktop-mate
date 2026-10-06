import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { markPlatform } from "./lib/platform";
import "./styles/global.css";

// Applied before first paint so the desktop shell never flashes its web
// background or chrome.
markPlatform(document.documentElement);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
