import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ccc } from "@ckb-ccc/connector-react";
import { CellulaWalletSigner } from "cellula-sdk";
import cellulaIcon from "./cellula.svg";
import { App } from "./App";
import "./style.css";

const testnet = new ccc.ClientPublicTestnet();

/** CCC's wallets, with the Cellula wallet first. It is not in CCC's list yet; a site adds it this way. */
class Signers extends ccc.SignersController {
  async addRealSigners(context: Parameters<ccc.SignersController["addRealSigners"]>[0]) {
    await this.addSigners("Cellula", cellulaIcon, [{ name: "CKB", signer: new CellulaWalletSigner(context.client) }], context);
    await super.addRealSigners(context);
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ccc.Provider name="Ward demo" defaultClient={testnet} clientOptions={[{ name: "CKB Testnet", client: testnet }]} signersController={new Signers()}>
      <App />
    </ccc.Provider>
  </StrictMode>,
);
