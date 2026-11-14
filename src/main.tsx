import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/fraunces/opsz-italic.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/app.css";
import "./styles/packs.css";
import { captureInstallPrompt } from "./packs/pwa";
import { warmPackCache } from "./atlas/warm";

captureInstallPrompt();
// Read the word-pack cache index in the background right away; the app never waits for it.
void warmPackCache();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const base = import.meta.env.BASE_URL;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${base}sw.js`)
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Cache the app itself right away, so the very first visit already works offline.
        const urls = performance
          .getEntriesByType("resource")
          .map((r) => r.name)
          .filter((u) => u.startsWith(location.origin + base) && !/\/atlas\/(img|thumb|audio)\//.test(u));
        reg.active?.postMessage({ type: "precache", urls: [...new Set([location.href.split("#")[0], ...urls])] });
      })
      .catch(() => null);
  });
}
