import React from "react";
import { createRoot } from "react-dom/client";
import { PlanbanPublicWebsite } from "./components/PlanbanPublicWebsite";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PlanbanPublicWebsite />
  </React.StrictMode>,
);
