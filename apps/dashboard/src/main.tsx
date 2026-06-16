import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardApp } from "./ui/DashboardApp.js";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <DashboardApp />
  </StrictMode>
);

