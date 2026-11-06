import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ccc } from "@ckb-ccc/connector-react";
import { App } from "./App";
import "./style.css";

const testnet = new ccc.ClientPublicTestnet();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ccc.Provider name="Ward demo" defaultClient={testnet} clientOptions={[{ name: "CKB Testnet", client: testnet }]}>
      <App />
    </ccc.Provider>
  </StrictMode>,
);
