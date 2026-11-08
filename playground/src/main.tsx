import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ccc } from "@ckb-ccc/connector-react";
import { CellulaWalletSigner } from "cellula-sdk";
import cellulaIcon from "./cellula.svg";
import { App } from "./App";
import type { Net } from "./lib";
import "./style.css";

/** CCC's wallets, with the Cellula wallet added before the rest (it is not in CCC's list yet). The
 * Cellula wallet is testnet only, so it is offered only there. */
class Signers extends ccc.SignersController {
  async addRealSigners(context: Parameters<ccc.SignersController["addRealSigners"]>[0]) {
    if (context.client.addressPrefix === "ckt") {
      try {
        await this.addSigners("Cellula", cellulaIcon, [{ name: "CKB", signer: new CellulaWalletSigner(context.client) }], context);
      } catch {
        /* never let one wallet keep the rest out of the list */
      }
    }
    await super.addRealSigners(context);
  }
}

const readNet = (): Net => {
  try {
    return localStorage.getItem("ward-net") === "mainnet" ? "mainnet" : "testnet";
  } catch {
    return "testnet";
  }
};

/** The network lives above the CCC provider, so switching it remounts the provider with the right client. */
function Root() {
  const [network, setNetwork] = useState<Net>(readNet);
  const client = useMemo(() => (network === "mainnet" ? new ccc.ClientPublicMainnet() : new ccc.ClientPublicTestnet()), [network]);
  const choose = useCallback((n: Net) => {
    try {
      localStorage.setItem("ward-net", n);
    } catch {
      /* private window: the choice just does not persist */
    }
    setNetwork(n);
  }, []);
  return (
    <ccc.Provider
      key={network}
      name="Ward playground"
      defaultClient={client}
      clientOptions={[{ name: network === "mainnet" ? "CKB Mainnet" : "CKB Testnet", client }]}
      signersController={new Signers()}
    >
      <App network={network} setNetwork={choose} />
    </ccc.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
