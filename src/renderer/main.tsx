import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { LbpDisplayProvider } from "./lbpDisplay";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <LbpDisplayProvider>
        <App />
      </LbpDisplayProvider>
    </I18nProvider>
  </StrictMode>,
);
