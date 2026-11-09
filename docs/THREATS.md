# Ward threat model

What a successful `verify()` is meant to guarantee, what it is not, and where each guarantee is enforced and tested. Read it next to [SPEC.md](SPEC.md); section numbers below are its sections.

The claim: `verify()` returns `ok: true` only when the holder of the claimed lock signed, for this platform, account, chain and time, a transaction that can never be committed. It does not prove continuous control, and it covers most locks, not all (see Gaps).

Each row is an attacker goal, how Ward stops it, and the test that holds it. The tests run the real lock in CKB-VM; a control that must pass sits next to each control that must fail.

## Forgery and replay

| Goal | Stopped by | Test |
| --- | --- | --- |
| Pass a proof made for another platform, account, chain or time | `expect` is required in full; the message is compared byte for byte, and its domain, account, nonce and chain must match, within an age window (`checkExpect`, SPEC 4, 8) | `verify.test.ts` |
| Reuse a proof a second time | The nonce is single-use: `claimNonce` is a compare-and-set, called once after the free checks and before any chain read | `verify.test.ts` |
| Stretch an old nonce by moving "Issued at" forward | The message is byte-identical to the one stored, so any edit fails before the lock runs | `verify.test.ts` |
| Reuse a signature across sites | The signed message names the domain and the genesis hash, so a proof for one site or chain does not check out on another | `verify.test.ts`, `vectors.test.ts` (mainnet proof refused on a testnet platform) |

## The signed transaction

| Goal | Stopped by | Test |
| --- | --- | --- |
| Sign a transaction shaped to favour the attacker, not the canonical proof | The verifier rebuilds the template from `(lock, message)` and requires `template.hash() == tx.hash()`, which pins every raw field: inputs, outputs, outputs data, version and header deps. Only the witness, which carries the signature, is not hashed | `adversarial.test.ts` (every single-field edit of every vector is refused as "not the proof template"), `template.test.ts` |
| Point the proof input at a cell the attacker can actually spend | The only input is an out point that cannot exist (`tx_hash = ckbhash("CKB lock proof v0\n" || lock hash || message)`, index `0xffffffff`), resolved to `{ capacity u64::MAX, the claimed lock, no type, no data }` (SPEC 3) | `template.test.ts` |
| Prove with a key that may move only part of an account | The resolved input carries capacity `u64::MAX`, so a capped or partial-authority key cannot satisfy the lock for the whole | `capped-key.test.ts` |

## The lock itself

| Goal | Stopped by | Test |
| --- | --- | --- |
| Use a lock that opens for anyone (always-success) | After the lock accepts, the verifier re-runs it with an empty witness; if that opens, the proof is refused (`probes`, SPEC 7) | `probes.test.ts`, `vm.test.ts` |
| Use a witness that does not commit to the message (a password or fixed preimage) | The verifier re-runs the same witness on the template of another message; if that opens, the proof is refused | `probes.test.ts`, `vm.test.ts` |
| Open an Omnilock as its administrator | An Omnilock with the admin flag (args byte 21, bit 0) is refused before any chain read, because any key on its admin list would open it (SPEC 6) | `verify.test.ts`, `omnilock-admin.test.ts` |
| Feed a forged settings or admin cell to change what the lock accepts | Cell deps are read live from the chain and never from contents the prover supplies; a lock that binds its settings to the account rejects a substituted cell | `vectors.test.ts` (forged-dep controls), `capped-key.test.ts` |
| Make the lock print a false result | The runner reads only the VM's own final line and exit status, not anything the lock wrote to its debug output | `vm.test.ts` |
| Get a different verdict from a weaker VM | Production uses `ward-vm`, the node's own `ckb-script`, under the chain's consensus at the tip epoch and with only the node's syscalls (SPEC 11); a syscall only ckb-debugger has stops `ward-vm` as a node would | `vm.test.ts` |

## Resource exhaustion

| Goal | Stopped by | Test |
| --- | --- | --- |
| Make the verifier do unbounded chain work | Cell deps are bounded before any read: an out point listed twice is refused first, dep-group member counts are read from the groups' data and refused above the limit before a member is read, and a member already seen is read once. Transaction and witness sizes are capped, and each chain read times out | `limits.test.ts` |

## Platform rules (weight over time)

A platform that counts weight from bindings needs more than `verify()` (SPEC 9). These are enforced by the platform, and exercised live by the playground's DAO voting example.

| Goal | Stopped by | Where |
| --- | --- | --- |
| Count a binding whose lock changed after the proof | A binding is counted only while every cell its proof ran with is still live at the snapshot block (`depsLiveAt`); a key rotation, recovery or lock upgrade spends one, and the owner proves again | `snapshot.test.ts` |
| Count capacity that is not a real DAO deposit | Weight is read only from Nervos DAO deposits under exactly that lock, live at the snapshot; a cell withdrawing is not counted, and a look-alike lock weighs nothing | `weight.test.ts` |
| Move a deposit between names to vote twice | One active binding per lock, bindings frozen while a vote is open, and a binding that moved to a new name waits a cooldown before it counts | playground `server.ts` (`/api/vote/*`), verified on a live vote cycle |

## Gaps

From SPEC 12, not covered today:

- Locks with a time condition (a `since` requirement or a header dep). The proof carries no header deps, so such a lock cannot run here.
- Locks whose signature does not cover the transaction hash. The probes catch the common cases (opens for anyone, opens for another message), but a lock whose authority is not tied to the transaction at all is outside the model.
- Ward proves control at the moment of the proof, not continuously. Between proofs, control can change (a multisig signer set, a recovery). Long-lived bindings rest on the cell-deps-live check, not on re-proving.

Ward has had no external security review. The guarantees above are argued and tested here, not independently audited.
