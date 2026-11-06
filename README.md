# Ward

Lock proof for CKB.

A lock-agnostic way for any CKB wallet to prove it controls a lock, for example to link Nervos DAO deposits to an account on a voting platform. It is the CKB counterpart of Ethereum's EIP-1271 and Bitcoin's BIP-322.

The wallet signs a transaction that can never be committed. The verifier rebuilds that transaction itself, reads the lock's cell deps from the chain, and runs the lock in CKB-VM. Exit 0 means the wallet controls the lock.

The full standard, with byte-exact templates, the rules a platform must follow, and test vectors, is in [docs/SPEC.md](docs/SPEC.md).

## Why

Voting platforms on CKB today accept one signature type. Metaforo, for example, binds only Neuron-style signatures (secp256k1 signed messages). A CKB lock is a program, so holders whose deposits sit under JoyID, a multisig, Omnilock or a smart-account lock have no way to link them. Checking each signature scheme separately does not scale: every new lock needs new verifier code and new wallet code.

Running the lock itself needs neither. Any wallet that can sign an ordinary transaction for its lock can sign the proof, and one verifier checks every lock that signs the transaction hash.

## How it works

- The only input points at an out point that cannot exist: `tx_hash = ckbhash("CKB lock proof v0\n" || lock hash || message)`, `index = 0xffffffff`. The verifier resolves it to `{ capacity u64::MAX, the claimed lock }`, so a key that may only move part of an account cannot prove it. One output under an all-zero lock carries the message.
- The message names the platform, the account, the lock hash, the chain's genesis hash, the time and a single-use nonce.
- After the lock accepts, the verifier runs it twice more, with an empty witness and with the same witness on another message. A lock that opens either way is open to anyone, and the proof is refused.
- An Omnilock in administrator mode is refused: any key on its admin list opens it, the owner's lock included.

Nodes refuse the proof as `Unknown(OutPoint)`. So a node cannot verify a proof either; the verifier needs a VM.

## Install

```sh
npm install ckb-ward
```

Two entries:

- `ckb-ward`: everything, the verifier included. Node only: the runner spawns ckb-debugger.
- `ckb-ward/wallet`: `message`, `parseMessage`, `proofTemplate`, `readProof` and the constants. No Node built-ins, so it bundles for a browser. This is what a wallet or a site needs.

## Use

```ts
import { ccc } from "@ckb-ccc/core";
import { ckbDebugger, message, proofTemplate, verify } from "ckb-ward";

const CHAIN = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606"; // testnet genesis, from config

// Platform: write the message, and store it under its nonce.
const text = message({ domain: "dao.example", account: "user-42", lock, chain: CHAIN, issuedAt: new Date(), nonce });

// Wallet: sign the template like any transaction (any CCC signer).
let tx = proofTemplate(lock, text);
tx = await signer.prepareTransaction(tx);
tx = await signer.signOnlyTransaction(tx);

// Platform: verify against what it stored. Every field of expect is required.
const result = await verify(
  { lock, message: text, tx },
  {
    rpcUrl: "https://testnet.ckb.dev/rpc",
    runLock: ckbDebugger(),
    expect: { message: stored.message, domain: "dao.example", account: "user-42", nonce, chain: CHAIN, maxAgeSeconds: 600 },
    claimNonce: () => markUsedIfUnused(nonce), // compare-and-set, before any chain read
  },
);
// { ok: true, fields, cycles, cellDeps } or { ok: false, reason, run? }
```

`verify` refuses when `expect` is missing, when the message is not the one issued, when the lock is an Omnilock in administrator mode, when the transaction is not exactly the template the verifier builds, when it breaks a limit (cell deps, dep group members, size), when a cell dep is not live on the chain, when the lock exits non-zero, or when the lock also opens without the owner. It throws only when the node cannot be reached or the runner cannot start. `cellDeps` lists the cells the proof ran with; a binding stays valid while they are live.

Verifying is the easy half. A platform that counts weight from bindings also needs the rules of section 9 of the spec: one active binding per lock, bindings frozen while a vote is open, weight read at one snapshot block from Nervos DAO deposits only, and a binding counted only while the cells its proof ran with were live at that block:

```ts
import { depsLiveAt } from "ckb-ward";
const at = await depsLiveAt(rpcUrl, binding.cellDeps, snapshotBlock); // cellDeps as verify() returned them
if (!at.live) skip(binding); // at.deps says which cell, and when it was created or spent
```

Wallets can call `readProof(tx, lock)` (from `ckb-ward/wallet`) to recognise a proof request and show its domain next to the site's origin, instead of a transfer.

### Wallets that sign it

- **Cellula wallet** (testnet, since 2026-11-05). A site asks through the wallet link (`cellula-sdk` `CellulaWalletSigner`, `signTransaction(proofTemplate(lock, message))`). The wallet shows the request as a proof: who asks, the account, the address, and that nothing leaves. It refuses a proof for another site, another network or an address that is not its own, and any request from a site on another device. Tested through its screen with a starter and a guarded account, and with a real phone passkey (section 13 of the spec).
- **JoyID** signs the template in its app (vector V2), but shows it as a transaction.

### Lock runner

`runLock` is pluggable: it receives a ckb-debugger mock transaction and returns `{ code, cycles, output }`. `ckbDebugger()` runs [ckb-debugger](https://github.com/nervosnetwork/ckb-standalone-debugger) (tested with 1.1.1) and reads only the debugger's own final lines and exit status, never text the lock printed:

```ts
ckbDebugger(); // `ckb-debugger` on PATH
ckbDebugger({ command: "/root/.cargo/bin/ckb-debugger", wsl: { distro: "Ubuntu" } }); // Windows, through WSL
ckbDebugger({ maxCycles: 70_000_000, tmpDir: "/tmp" }); // defaults shown for maxCycles
```

ckb-debugger is a development tool: its VM version does not follow the chain, and it adds syscalls no node has. For production, `wardVm()` runs `ward-vm` (in `vm/`): the node's own `ckb-script`, from the release mainnet and testnet run (0.210.0), under the chain's consensus at the tip's epoch, with only the node's syscalls (section 11 of the spec).

```sh
cd vm && cargo build --release   # target/release/ward-vm
```

```ts
import { tipEpoch, wardVm } from "ckb-ward";
const rpcUrl = "https://mainnet.ckb.dev/rpc";
wardVm({ command: "vm/target/release/ward-vm", chain: "mainnet", epoch: () => tipEpoch(rpcUrl) });
```

## Tests

```sh
npm install
npm run typecheck
npm test
```

`tests/vectors/` holds real signed proofs: from mainnet secp256k1 and the JoyID app, replayed against mainnet's cell deps, and from testnet secp256k1, the JoyID app with its main key and with a sub key, the Cellula smart-account lock (starter and guarded), a 2-of-3 multisig, anyone-can-pay, Omnilock in Dogecoin mode and the Nostr lock. Each is replayed with controls that must be refused: another message, one flipped signature bit, a wrong key, a missing or forged settings cell dep, one multisig signature where two are needed, anyone-can-pay with no signature, an empty witness, and `test_tx_pool_accept` on the node. Other tests cover a smart account with capped keys, an Omnilock whose administrator signs for the owner, locks anyone can open, a lock that prints a fake result, and the verifier's limits, each next to a control that passes.

Without configuration, tests that run a lock are skipped. Set `CKB_DEBUGGER` (the executable) and, on Windows, `CKB_DEBUGGER_WSL` (the WSL distro that has it), or `WARD_VM` and `WARD_VM_WSL` for `ward-vm`. With both set, `tests/vm.test.ts` runs every vector under both and checks that they agree. Set `CKB_WARD_OFFLINE=1` to skip everything that needs the testnet RPC (`CKB_RPC_URL` overrides it).

```sh
CKB_DEBUGGER=ckb-debugger npm test
# Windows, Git Bash (stop it rewriting the Linux path):
MSYS_NO_PATHCONV=1 CKB_DEBUGGER_WSL=Ubuntu CKB_DEBUGGER=/root/.cargo/bin/ckb-debugger npm test
```

The vectors depend on testnet cell deps staying live.

## Status

Prototype, on npm as `ckb-ward`. Vectors are from testnet, and two from mainnet. The spec is a v1 draft and may change.

Known gaps are listed in section 12 of the spec: locks with a time condition, or whose signature does not cover the transaction hash, are not covered.

## License

MIT, see [LICENSE](LICENSE). Author: LusoCryptoLabs.
