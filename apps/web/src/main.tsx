import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ToastProvider } from "./hooks/useToast";
import { BrowserNotifyProvider } from "./hooks/useBrowserNotify";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserNotifyProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserNotifyProvider>
  </React.StrictMode>,
);
