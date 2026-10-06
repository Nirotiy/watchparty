import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "./App"
import { AppErrorBoundary } from "./components/error-boundary"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
