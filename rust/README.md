# ckb-ward (Rust)

The backend side of a Ward lock proof in Rust: issue the message and the proof template, and verify
what the wallet signed. Same format, same checks and same refusal texts as the TypeScript package
(`docs/SPEC.md`).

The verifier rebuilds the proof transaction from the lock and the message, reads the lock's cell
deps live from the chain, and runs the lock in CKB-VM in process with `ckb-script`, the node's own
crate (1.2.1, which pins ckb-vm 0.24.15 like node 0.210.0). It runs under mainnet's or testnet's
consensus from the spec bundled with the node's crates, chosen by the chain in the message. No
`ward-vm` or `ckb-debugger` process is needed.

Not on crates.io yet. From git:

```toml
[dependencies]
ckb-ward = { git = "https://github.com/LusoCryptoLabs/ckb-ward" }
```

## Use

```rust
use ckb_ward::{iso_time, json, message, verify_json, Expect, RpcClient, Verdict, VerifyOptions};

// Issue: store the message with the nonce, send the template to the page.
let lock = json::script_from_json(&lock_json)?;
let text = message("dao.example", account, &lock, &chain, &iso_time(now_ms), &nonce)?;
let template = json::template_json(&lock, &text, &Default::default());

// Verify what the wallet signed.
let expect = Expect { message: text.clone(), domain: "dao.example".into(), account: account.into(),
                      nonce: nonce.clone(), chain, max_age: Duration::from_secs(600), now: None };
let rpc = RpcClient::new("https://testnet.ckb.dev/rpc");
match verify_json(&lock_json, &text, &signed_tx_json, &expect, &rpc, &VerifyOptions::default(),
                  |_| mark_nonce_used(&nonce))? {
    Verdict::Accepted(a) => { /* bind; keep a.cell_deps */ }
    Verdict::Refused(r) => { /* r.reason */ }
}
```

The wallet side is unchanged: with CCC,
`signer.signOnlyTransaction(await signer.prepareTransaction(ccc.Transaction.from(template)))`.

- `verify` and `verify_json` return `Err` only when the node cannot be reached or the chain has no
  bundled consensus (pass one in `VerifyOptions::consensus`). Anything the prover controls is a
  `Verdict::Refused`, including a proof whose deps leave out the lock's code.
- The `claim_nonce` callback runs once, after every check that needs no chain read and before the
  first one. Put the compare-and-set there.
- Chain reads go through the `Rpc` trait. `RpcClient` (feature `rpc`, on by default) is a blocking
  HTTP client; from async code, call `verify` inside `spawn_blocking`, or implement `Rpc` on your
  own client.
- `deps_live_at` and `dao_weight_at` are the snapshot rules of SPEC section 9, for a platform that
  counts weight from bindings.

`examples/bind_server.rs` is a complete binding server on testnet (nonce, template, verify, one use
per nonce). `examples/verify.rs` verifies proofs given as JSON on stdin.

## Tests

```sh
cargo test                       # offline: chain answers from tests/fixtures/rpc.json.gz
CKB_WARD_ONLINE=1 cargo test     # the same against the testnet and mainnet RPC
CKB_WARD_RECORD=1 cargo test     # live, and the answers written back to the fixture
```

- The 17 signed proofs in `../tests/vectors` are accepted, with the cycles of SPEC section 13; one
  flipped signature bit, the same witness on another message, and the 19 controls are refused with
  the exit codes the TypeScript suite asserts.
- Every refusal of SPEC section 5, each limit at and one past its value, the nonce claimed once and
  only after the free checks, and the chain refusals (another genesis, a dead or unknown dep, a bad
  dep group, too many group members, an unknown header).
- The probes, the cycle limit, a since and a header dep, with the locks `../tests/elf.ts` assembles
  (`tests/fixtures/elf.json`).
- The snapshot and DAO weight cases of the TypeScript suite, on the same testnet history.

`scripts/compare-ts.ts` runs the same proofs through the TypeScript `verify()` and this crate against
the live chain and compares the verdicts. `scripts/e2e.ts` drives `examples/bind_server.rs` with CCC's
own signers and fresh keys for eight locks.
