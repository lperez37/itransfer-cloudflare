import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Intercept install prompt globally so the browser never shows it on public pages.
// The admin Layout will retrieve and use it via usePWAInstall().
// `Window.__pwaPrompt` is declared (with its event type) in usePWAInstall.ts.
window.__pwaPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__pwaPrompt = e as Window["__pwaPrompt"];
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Register service worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
