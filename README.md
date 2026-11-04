# ckb-lock-proof

A lock-agnostic way for any CKB wallet to prove it controls a lock, for example to link Nervos DAO deposits to an account on a voting platform. It is the CKB counterpart of Ethereum's EIP-1271 and Bitcoin's BIP-322.

The wallet signs a transaction that can never be committed. The verifier rebuilds that transaction itself, reads the lock's cell deps from the chain, and runs the lock in CKB-VM. Exit 0 means the wallet controls the lock.

The full standard, with byte-exact templates and test vectors, is in [docs/SPEC.md](docs/SPEC.md).

## Why

Voting platforms on CKB today accept one signature type. Metaforo, for example, binds only Neuron-style signatures (secp256k1 signed messages). A CKB lock is a program, so holders whose deposits sit under JoyID, a multisig, Omnilock or a smart-account lock have no way to link them. Checking each signature scheme separately does not scale: every new lock needs new verifier code and new wallet code.

Running the lock itself needs neither. Any wallet that can sign an ordinary transaction for its lock can sign the proof, and one verifier checks every lock that signs the transaction hash.

## How it works

- The only input points at an out point that cannot exist: `tx_hash = ckbhash("CKB lock proof v0\n" || lock hash || message)`, `index = 0xffffffff`. The verifier resolves it to `{ capacity 0, the claimed lock }`. One output under an all-zero lock carries the message.
- The message names the platform, the account, the lock hash, the chain's genesis hash, the time and a single-use nonce.

Nodes refuse it as `Unknown(OutPoint)`. So a node cannot verify a proof either; the verifier needs a VM.

## Use

```ts
import { ccc } from "@ckb-ccc/core";
import { ckbDebugger, message, proofTemplate, verify } from "ckb-lock-proof";

// Platform: write the message.
const text = message({
  domain: "dao.example",
  account: "user-42",
  lock,
  chain: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606", // testnet genesis
  issuedAt: new Date(),
  nonce, // random, at least 64 bits, stored for this account
});

// Wallet: sign the template like any transaction (any CCC signer).
let tx = proofTemplate(lock, text);
tx = await signer.prepareTransaction(tx);
tx = await signer.signOnlyTransaction(tx);

// Platform: verify.
const result = await verify(
  { lock, message: text, tx },
  {
    rpcUrl: "https://testnet.ckb.dev/rpc",
    runLock: ckbDebugger(),
    expect: { domain: "dao.example", account: "user-42", nonce, maxAgeSeconds: 600 },
  },
);
// { ok: true, fields, cycles } or { ok: false, reason, run? }
```

`verify` refuses when the message is malformed or names another lock or chain, when the transaction is not exactly the template the verifier builds, when a cell dep is not live on the chain, or when the lock exits non-zero. It throws only when the node cannot be reached or the runner cannot start.

### Lock runner

`runLock` is pluggable: it receives a ckb-debugger mock transaction and returns `{ code, cycles, output }`. `ckbDebugger()` runs [ckb-debugger](https://github.com/nervosnetwork/ckb-standalone-debugger) (tested with 1.1.1):

```ts
ckbDebugger(); // `ckb-debugger` on PATH
ckbDebugger({ command: "/root/.cargo/bin/ckb-debugger", wsl: { distro: "Ubuntu" } }); // Windows, through WSL
ckbDebugger({ maxCycles: 70_000_000, tmpDir: "/tmp" }); // defaults shown for maxCycles
```

ckb-debugger is a development tool. A production verifier should embed `ckb-script` with the target chain's consensus (see section 9 of the spec).

## Tests

```sh
npm install
npm run typecheck
npm test
```

`tests/vectors/` holds real signed proofs from testnet: secp256k1, the JoyID app and the Cellula smart-account lock (starter and guarded). Each is replayed with controls that must be refused: another message, one flipped signature bit, a wrong key, a missing or forged settings cell dep, and `test_tx_pool_accept` on the node.

Without configuration, tests that run a lock are skipped. Set `CKB_DEBUGGER` (the executable) and, on Windows, `CKB_DEBUGGER_WSL` (the WSL distro that has it). Set `CKB_LOCK_PROOF_OFFLINE=1` to skip everything that needs the testnet RPC (`CKB_RPC_URL` overrides it).

```sh
CKB_DEBUGGER=ckb-debugger npm test
# Windows, Git Bash (stop it rewriting the Linux path):
MSYS_NO_PATHCONV=1 CKB_DEBUGGER_WSL=Ubuntu CKB_DEBUGGER=/root/.cargo/bin/ckb-debugger npm test
```

The vectors depend on testnet cell deps staying live.

## Status

Prototype. Tested on testnet only. Not audited. The spec is a v0 draft and may change. Not published to npm.

Known gaps are listed in section 10 of the spec: JoyID sub-keys are untested, and locks whose signature does not cover the transaction hash, or that read header deps or `since`, are not covered.

## License

MIT, see [LICENSE](LICENSE). Author: LusoCryptoLabs.
