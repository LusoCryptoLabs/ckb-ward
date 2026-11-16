# Bind server

A small service that binds any CKB lock to an account with a Ward proof, and reads the lock's Nervos
DAO weight at a snapshot block. It is the piece a voting platform adds next to the binding it has
today.

Today a platform that binds addresses with a Neuron message signature recovers a secp256k1 key from
`{ message, signature }` and builds a sighash address from it. A depositor whose deposit sits under
JoyID, a multisig, Omnilock or a smart-account lock has no such key, so the deposit cannot be bound
and does not count. With Ward the wallet signs a transaction that can never be committed, and the
server runs the deposit's own lock on it. Any wallet that can sign a transaction can bind, with no
new code in the wallet.

Weight stays what it is: the platform reads it per address, as before. `GET /weight` shows how with
`daoWeightAt`, if it wants it from the chain.

## Routes

```text
POST /bind/request  { account, address }  -> { nonce, message, template }
POST /bind/verify   { nonce, tx }         -> { ok, account, address, lockHash, cycles, cellDeps }
                                           | { ok: false, reason }
GET  /weight?address=...&block=...        -> { weight, deposits, withdrawing }
```

1. The page asks `/bind/request` with the account and the address the wallet gave.
2. The wallet signs `template` as an ordinary transaction (CCC: `signer.signTransaction`).
3. The page posts the signed transaction to `/bind/verify`. On `ok`, the platform stores the
   address against the account, as it stores a Neuron-bound address today.

A request is good for 10 minutes and for one attempt, accepted or refused.

## Run

```sh
NETWORK=testnet DOMAIN=vote.example PORT=8090 node examples/bind-server/server.ts
```

`DOMAIN` is the platform's host: the wallet shows it, and a proof made for another host is refused.

The lock runs in one of two runners:

- **ckb-vm-js** (default): CKB's own verifier and CKB-VM in WebAssembly, JavaScript only. Install
  it next to ckb-ward. It is not on npm yet; its CI package works (`playground/vendor/`).
- **ward-vm**: `RUNNER=ward-vm WARD_VM=/path/to/ward-vm`, the node's own script crates as a native
  binary (`vm/`, see the [top README](../../README.md#lock-runner)).

Both give the same exit code and cycles on every saved proof (`tests/ckbvmjs.test.ts`).

## What the platform still decides

- Which network, and its genesis hash, from its own config.
- Where requests live: this example keeps them in memory; a platform keeps them in its database.
- Whether a binding stays valid: a proof is tied to the cell deps it ran with
  (`cellDeps` in the answer), and `depsLiveAt` checks them at a snapshot block.

## Checked

`tests/bind-server.test.ts`, on testnet with a throwaway key, under ckb-vm-js and under ward-vm
(2026-11-16): the proof binds; one changed signature byte is refused by the lock (`lock exited -31`);
the same request posted again is refused; a mainnet address on a testnet server is refused; a fresh
address weighs 0.
