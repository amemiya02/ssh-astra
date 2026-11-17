import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "./index.css";
import { App } from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import { applyInitialTheme } from "./theme/theme";
import { ThemeProvider } from "./theme/ThemeProvider";

applyInitialTheme();

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={500}>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
