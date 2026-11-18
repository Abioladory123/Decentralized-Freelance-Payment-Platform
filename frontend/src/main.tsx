import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { initSentry } from "./lib/monitoring";

// Initialize Sentry error reporting if VITE_SENTRY_DSN is configured (issue #308).
initSentry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
