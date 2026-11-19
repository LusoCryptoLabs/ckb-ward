# Ward: lock proof for CKB, v1

Status: draft. Prototype, tested on testnet only.

v1 replaces the v0 draft after two reviews. Variant B is gone (section 14). The verifier resolves the proof input with capacity u64::MAX, runs two "no exclusive control" probes, and bounds its own work. Platforms get normative rules (section 9). On 2026-11-18 the proof output moved under the claimed lock, so a wallet reads from the transaction itself which of its locks is asked to sign. That changed the bytes a wallet signs, and the domain tag became `CKB lock proof v1\n` (section 4).

## 1. Purpose

A platform sometimes needs to know that the person behind one of its accounts controls a CKB lock. A governance site, for example, wants to count the Nervos DAO deposits held under a lock as that account's voting weight. Ethereum answers this with EIP-1271 for contract accounts and Bitcoin with BIP-322 for any script.

On CKB a lock is a program. A verifier that checks one signature scheme (secp256k1 with a known message prefix, say) cannot check a JoyID passkey, a multisig, an Omnilock in Dogecoin mode or a smart-account lock. Each new lock would need new verifier code and new wallet code.

This spec follows BIP-322: the prover signs a transaction that can never be committed, and the verifier runs the claimed lock on it. Every wallet that can sign an ordinary transaction for its lock can produce a proof, and one verifier handles every lock that signs the transaction hash.

What a valid proof shows: at verification time, some key (or set of keys) able to authorize the template, which moves the input's whole u64::MAX capacity away from the lock, produced a witness that makes the lock accept a transaction committing to the message. It does not show who holds that key, that they will keep it, or anything about type scripts.

## 2. Terms

- **ckbhash**: BLAKE2b-256 with personalization `ckb-default-hash`, the hash CKB uses for transaction and script hashes.
- **lock hash**: ckbhash of the molecule-serialized `Script`.
- **prover**: the person (and their wallet) who claims control of the lock.
- **verifier**: the code that checks the proof.
- **platform**: the service that issues messages, runs the verifier and keeps bindings.
- **binding**: a platform's record that links a lock to one of its accounts.
- 1 CKB = 10^8 shannons.

MUST, MUST NOT, SHOULD and MAY in sections 5 to 10 are normative.

## 3. Message

The platform writes the message; the prover signs it as part of a transaction. UTF-8, lines separated by a single LF (0x0a), no trailing LF, at most 1024 bytes, exactly six lines:

```text
{domain} wants you to prove control of a CKB lock.
Account: {account}
Lock hash: {lock hash}
Chain: {chain}
Issued at: {issued at}
Nonce: {nonce}
```

| Field | Format | Why |
| --- | --- | --- |
| domain | host name of the platform, optional `:port`; letters, digits, `.` and `-` | A proof made for one platform is refused by another, because each verifier checks its own domain. Where the wallet shows the message, it also tells the user who is asking (section 10). |
| account | 1 to 256 printable ASCII characters (0x20 to 0x7e), no space at either end | Binds the proof to the account the lock is being linked to. A proof captured for account A cannot link the lock to account B. ASCII only, so an account name cannot carry a line break (U+2028), a right-to-left override (U+202E), a C1 control (U+0085) or look-alike letters into the text a wallet shows. |
| lock hash | `0x` and 64 lowercase hex digits, the lock hash of the claimed lock | Lets the user see which lock is being proven. The verifier checks it equals the claimed lock's hash. |
| chain | `0x` and 64 lowercase hex digits, the genesis block hash | The same lock exists on every chain (a secp256k1 key has the same lock on testnet and mainnet). Without this a testnet proof would also be a mainnet proof. Testnet: `0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606`. Mainnet: `0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5`. |
| issued at | RFC 3339 in UTC with `Z`, optional fraction of a second, e.g. `2026-11-04T18:00:00Z` | The verifier refuses old proofs (section 8). |
| nonce | 1 to 128 characters from `A-Z a-z 0-9 . _ ~ -` | Chosen by the platform, used once (section 9). Platforms use at least 64 random bits. |

The first line follows the shape of EIP-4361 (Sign-In with Ethereum) so it reads the same way to users who have seen that.

## 4. Proof transaction

The only input points at an out point that no transaction can create.

```text
TAG = "CKB lock proof v1\n"                    (18 bytes, ASCII, ends with LF)
P   = ckbhash(TAG || lock hash || message)     (lock hash as 32 raw bytes, message as UTF-8)
n   = byte length of the message
s   = byte length of the claimed lock          (32 of code hash, 1 of hash type, its args)
```

| Field | Value |
| --- | --- |
| version | 0 |
| cell_deps | whatever the lock needs, chosen by the wallet |
| header_deps | whatever a header-reading lock needs, usually none, chosen by the wallet |
| inputs | exactly one: `previous_output = { tx_hash: P, index: 0xffffffff }`, `since = 0`, or a value the wallet sets to satisfy a matured absolute time lock |
| outputs | exactly one: `lock` = the claimed lock, `capacity = (8 + s + n) * 10^8` shannons, no type |
| outputs_data | exactly one: the message bytes |
| witnesses | exactly one: what the lock needs, as the wallet writes it (usually a `WitnessArgs` with the signature in `lock`) |

The input cell is resolved **by the verifier** to `{ capacity: 0xffffffffffffffff (u64::MAX), lock: the claimed lock, type: none, data: empty }`. The prover never supplies it. The template carries the same cell locally, so a signer computes the sighash without the chain and sees what the lock will see.

Why these values:

- **index 0xffffffff.** No transaction can have 2^32 - 1 outputs within the block size limit, so the out point cannot exist. Nodes refuse the signed proof with `Unknown(OutPoint(...))` (measured with `test_tx_pool_accept` and `estimate_cycles`).
- **P commits to the tag, the lock and the message.** The tag keeps P apart from any real transaction hash. Another lock or another message gives another transaction, so a signature cannot be moved between them.
- **The tag is versioned.** It names the bytes of the signed transaction. Their first form put the output under a lock with an all-zero code hash, with the tag `CKB lock proof v0\n`. Moving the output under the claimed lock changed them, so the tag is now `CKB lock proof v1\n`, and a signature made for one form does not open the other (measured, `tests/version.test.ts`). A later change to the signed bytes gets a new tag.
- **input capacity u64::MAX.** Some locks limit what a key may move in one transaction. The Cellula smart-account lock v6 lets the owner add keys with a per-transaction cap and counts as outflow what leaves the account. v0 resolved the input with capacity 0, so the outflow was only the (41 + n) CKB output, and a key capped at 1,000 CKB could prove the whole account (measured: exit 0). At u64::MAX the same key exits 27, over its cap, and a key with no cap exits 0 (measured, `tests/capped-key.test.ts`). The transaction hash covers out points, not the cells they resolve to, so that change touched no signed byte. With the output under the claimed lock, the same lock counts it as staying in the account, and the capped key still exits 27 (the same test runs both forms).
- **output capacity (8 + s + n) CKB.** That is the output's occupied capacity: 8 bytes of capacity, the lock, then the data. CCC 1.19 and later raises an output below its occupied capacity to that value while building a transaction, so wallets built on CCC produce this value whatever the template said. The spec fixes it so every implementation builds the same bytes. Measured: the JoyID app signed a 352 CKB output for a 289 byte message under its 55 byte lock.
- **output under the claimed lock.** Output locks never run. The output shows the message to wallets that show outputs, and it names the lock: a wallet with several locks reads from the transaction which one is asked to sign, and a wallet that receives the transaction without the input cell can rebuild that cell from it. The lock is then part of the signed bytes, so a transaction whose output lock is not the lock P commits to is the template of no lock at all (measured, `tests/version.test.ts`). A lock that reads outputs under itself sees this one. anyone-can-pay does, and still refuses without the key: the output carries data and holds less than the input (vector V6).

Signing. The wallet signs as it would any transaction spending a cell under the lock. A signer that needs the input cell (to size the witness placeholder or to find the lock) gets it from the template: CCC's `CellInput` carries `cellOutput` and `outputData` locally. A wallet that receives the transaction without that cell can rebuild it: capacity u64::MAX, the lock of the output, no type, no data. A wallet that insists on looking up inputs on chain cannot sign the proof. The JoyID app signs it (vector V2).

Earlier form. Until 2026-11-18 the output was under `{ code_hash: 0x00 * 32, hash_type: "data", args: 0x }`, its capacity was (41 + n) CKB, and TAG was `CKB lock proof v0\n`. The reference code builds new proofs in the current form only. Its verifier still reads the earlier form (it tries the current form, then the earlier one, and reports which matched) until vectors V10 and V11 are signed again.

## 5. Verifier algorithm

Input: the claimed lock L, the message M, the signed transaction T, and the platform's expectation E: the exact message it issued for this nonce, its own domain, the account, the nonce, the chain's genesis hash from its config, and the age window. Every field of E is required. The verifier has a node RPC for its chain and a CKB-VM runner. Any refusal ends the check. Node errors mean "could not verify", not "refused". Steps 1 to 7 read nothing from the chain.

1. Refuse when E or any field of it is missing.
2. Parse M (section 3). Refuse when malformed.
3. Refuse unless M equals E's message byte for byte.
4. Refuse unless the lock hash line equals the lock hash of L. Refuse when L is an Omnilock with the administrator flag (section 6, rule 6).
5. Refuse unless the domain, account, nonce and chain lines equal E's, `now - issued at` is within E's window, and `issued at` is not more than 60 seconds ahead of `now`.
6. Refuse unless T has exactly one witness, T's serialized size in a block (its bytes plus 4) is at most 597,000, the witness is at most 65,536 bytes, T lists at most 16 cell deps with no out point twice, and at most 8 header deps (section 7).
7. Build the template of section 4 from (L, M), copy T's cell deps, header deps and the input's `since` into it, and refuse unless its transaction hash equals T's. The transaction hash covers every field but the witnesses, so this one comparison checks every value in section 4. Cell deps, header deps and `since` are the prover's to set, like the witness: they let a lock that reads them run, and cannot forge control, since the out point and the output stay pinned (rule 2) and the signature over the hash is still required.
8. Claim the nonce (section 9, rule 3). Refuse when it was already used.
9. Refuse unless the node's genesis hash (`get_block_hash(0)`) equals E's chain.
10. Read every cell dep of T from the node as a live cell with data. For each dep group, read the member count from its data (an `OutPointVec`: a 4 byte count, then 36 bytes per out point). Refuse when the data is not that shape, or when all groups together list more than 32 cells, before reading any member. Then read each member not already read, as a live cell. Refuse when any cell is not live. Read each header dep of T live from the node, by block hash, each hash once; refuse when a header is unknown. Each read has a timeout.
11. Run the lock script group of input 0 in CKB-VM with T, the resolved input, the resolved deps and the resolved headers, under a cycle limit. Refuse unless the lock exits 0.
12. Probe for exclusive control (section 6, rule 4). Run the lock again on (a) T with its witness replaced by an empty one, and (b) the template of M', which is M with the nonce replaced by a fresh random value, with T's cell deps and T's witness. Refuse when either exits 0.
13. Accept, and return the out points read in step 10. The binding records them (section 9, rule 8).

## 6. Safety rules

Each rule was found while building or reviewing this. A verifier that breaks one accepts proofs it should refuse.

**Rule 1: cell deps come from the chain as live cells, never from the prover.** A lock's behaviour depends on its deps. For a lock with `hash_type` type, the code is found by type script hash, so a forged dep can carry any code. Some locks also read settings from deps. Measured with the Cellula smart-account lock, whose guarded form reads its authenticators from a Config Cell given as a cell dep: a proof signed by a key that is not an authenticator, sent with a forged copy of the Config Cell that lists that key, is **accepted** by the lock (exit 0) when the verifier uses the prover's copy. Read from the chain, the forged out point is not live and the proof is refused (vector V4, `forgedConfig`).

**Rule 2: the verifier builds the template.** If the verifier took any transaction whose input 0 is under L, the prover could add inputs or outputs that make L accept without the owner's key. Owner-lock style locks accept when another input carries a given lock hash. Proxy-lock style locks accept when a given cell is present. The anyone-can-pay lock accepts without a signature when an output under the same lock receives more. The template pins one input and one output, so none of these paths opens. Cell deps, header deps and the input's `since` are the prover's to set (section 5, step 7): they let a lock that reads them run, but add no input or output, so they open none of these paths. Measured with the anyone-can-pay lock (vector V6): with no signature it refuses the template (exit -44, no output to pair the input with), and it accepts the same empty witness (exit 0) on a transaction whose only output is under the same lock and receives the input's whole capacity, which the template check refuses. The owner-lock and proxy-lock attacks are reasoning, not measured here.

**Rule 3: the input is a constant of the verifier, at u64::MAX.** Never a cell the prover names, and never a smaller capacity: a lock that caps what a key may move must see the whole account leave (section 4).

**Rule 4: no exclusive control, no proof.** A lock that accepts the template with an empty witness opens for anyone (an always-success lock). A lock that accepts the same witness on another message's template does not bind its witness to the message (a lock opened by a password or a hash preimage), so anyone who has seen one proof can make another. Neither shows control by one holder, and binding such a lock would let anyone claim the deposits under it. Measured with locks assembled for the tests (`tests/probes.test.ts`): an always-success lock and a 4 byte password lock are accepted with the probes off and refused with them on. Every real lock in section 13 passes them. The probes stop locks that are open by construction; a lock written to tell a probe from a real proof could still pass them.

**Rule 5: read the VM's result, not text the lock printed.** A lock can print through the debug syscall, and ckb-debugger writes that text to stdout as `Script log: ...` with its line feeds kept, so it can print lines that look like the debugger's own. The v0 runner took the first `Run result:` anywhere in stdout and stderr together, and accepted a lock that printed `Run result: 0` and then exited 1 (measured). The runner now reads stdout and stderr apart, takes only the last two lines of stdout (`Run result: <code>`, `All cycles: <n>`), and counts exit 0 only when the debugger process also exits 0 (ckb-debugger 1.1.1 exits 254 for any other result, measured). An embedded VM avoids the question: it returns the exit code itself.

**Rule 6: no lock an administrator can open.** An Omnilock whose flags byte (args byte 21) has bit 0 set carries the type hash of an admin list cell, which holds SMT roots of identities. A witness that names an identity on that list, with its SMT proof, is checked against that identity's signature instead of the owner's. The administrator creates and controls the list cell, so reading deps from the chain (rule 1) does not stop it, and one list can serve many locks: one admin key would prove every lock that names it. Measured on both live testnet Omnilock deployments (CCC's, code data hash `0x6b29b6f1...`, and the 2022 one), with fresh keys and a list cell fabricated in a local node stub (`tests/omnilock-admin.test.ts`): the admin's key, naming the admin's identity, opens a lock whose owner is another key (exit 0, about 1.5 million cycles), passes both probes, and `verify()` without this rule accepts it. Controls on the same lock: the owner's key exits 0 on CCC's deployment (the 2022 one stops the VM, `write on executable page`, while the same owner without the flag exits 0); a key not on the list naming itself exits 59 (not on the whitelist); the same key naming the admin's identity exits -31 (the signature does not match it); the admin's proof re-signed without the list cell exits 1 (no cell with that type hash). The verifier refuses such a lock at step 4, before any chain read, for the owner's proofs too. It recognises Omnilock by code hash (`OMNILOCK_CODE_HASHES`: the testnet and mainnet type hashes and the data hashes of the three testnet binaries, one of which is the mainnet code, read from the mainnet cell on 2026-11-05); a copy deployed under another code hash is not recognised.

## 7. Limits

A proof is untrusted input that makes the verifier read the chain and run code. Each limit below bounds that work. With all of them, one proof costs at most one genesis read, 48 cell reads and 3 lock runs.

| Limit | Value | Why |
| --- | --- | --- |
| cell deps listed | 16 | JoyID, the largest measured, uses 5. |
| an out point listed twice | refused | The node refuses it (`DuplicateCellDeps`). Without it, the first review made one proof list a dep group of 1,000 members 15 times: 15,018 cell reads. |
| cells listed by dep groups | 32 in total, counted from the groups' data before any member is read; each member read once | The secp256k1 dep group, the largest measured, lists 2. The node itself allows 2,048 expanded deps (measured by the review: 2,048 accepted, 2,049 refused with `OverMaxDepExpansionLimit`), but only after reading every member. |
| transaction size | 597,000 bytes as serialized in a block (the transaction's bytes plus a 4 byte offset) | The consensus block limit. Measured on testnet: at 597,000 the node goes past that check, at 597,001 it refuses with `ExceededMaximumBlockBytes`. The node's pool refuses above 512,000 (measured), a node setting. |
| witness | 65,536 bytes; a verifier may raise it for a lock with larger signatures | The largest measured is 7,913 (the quantum-resistant lock with one SLH-DSA-SHA2-128s key, V15 and V17). It leaves room for larger post-quantum parameter sets: SLH-DSA 256f is 49,856 bytes by its parameter set (not measured here). |
| message | 1,024 bytes | Section 3. |
| each chain read | a timeout, 10 seconds by default | A slow or stalled node would hold the verifier. |
| each lock run | a cycle limit, 70,000,000 here | The largest saved proof takes 12,240,137 cycles (the quantum-resistant lock on testnet, V15). |
| request body | platforms cap it; 256 KiB is enough | A proof at every limit above is under 140 KB as JSON. |

## 8. Replay and expiry

| Replay | Stopped by |
| --- | --- |
| the same proof sent again to the same platform | nonce used once |
| a proof made for another platform | domain |
| a proof for another account on the same platform | account, and the stored message |
| a proof for another lock | the stored message (its lock hash line), and P, which commits to the lock hash |
| a testnet proof on mainnet, or the reverse | chain line, checked against the platform's config and the node's genesis |
| an old proof, or an old nonce with a new "Issued at" | issued at window; the stored message pins "Issued at" |
| the proof transaction sent to the chain | its input does not exist |

The platform only has to keep used nonces for as long as its window. 10 minutes is a reasonable window for an interactive flow.

A proof shows control at verification time. A key can be shared later, and for locks whose code can be upgraded (`hash_type` type) or whose settings live in cells (the smart account's Config Cell), the set of keys that control the lock can change after the proof. Section 9, rule 8 ties a binding to the cells its proof used.

## 9. Platform rules

A verifier only says that a lock accepted one transaction. The rules below are what make that safe to count. A platform that counts weight from bindings MUST follow them.

1. **Issue and store.** The platform writes the message itself: its own domain, the chain from its config, the account, the lock, the time, and a fresh nonce of at least 64 random bits. It MUST store the exact text per nonce, pass it as E's message, and compare byte for byte. It MUST NOT rebuild the message from the proof.
2. **Tie the nonce.** A nonce is issued for one account and one lock hash, and is good only for both.
3. **Use once, burn early.** The platform MUST mark the nonce used with a compare-and-set (for example `UPDATE ... SET used_at = ? WHERE nonce = ? AND used_at IS NULL`, accepted only when it changed one row), at the latest before the first chain read (step 8; `verify()` calls `claimNonce` there). A nonce that reached the chain reads is burned whatever the result; another attempt needs a new message. Measured by the second review: the same proof sent three times in parallel bound once.
4. **Pass every field of E.** The reference `verify()` refuses without them.
5. **Pin the chain.** The genesis hash comes from the platform's config, never from the message or the node. The verifier checks both against it.
6. **One active binding per lock.** A platform MUST keep at most one active binding per lock hash (a unique index does it). Binding a lock that is already bound to another account moves it: the previous account is notified, the moved binding carries no weight until a cooldown has passed (for example 72 hours), and the history of bindings is kept. Without this, one key vouches for many accounts (measured by the first review: two accounts bound the same lock and `verify()` accepted both).
7. **Votes.** While a vote is open, bind, unbind and rebind are refused. Each lock counts at most once per vote, whichever account holds it when ballots are counted.
8. **Weight.**
   - Read at one snapshot block, the same for every account in a vote.
   - Count Nervos DAO deposits only: cells whose type is the Nervos DAO script and whose data is 8 zero bytes. A withdrawing cell keeps the DAO type but its data is a block number; counting it let one 200 CKB deposit count twice when it moved between snapshot and tally (measured by the second review).
   - Search by the exact lock script (indexer `script_search_mode: "exact"`) and check each cell's lock hash again. The indexer's default prefix search also returns locks whose args start with the same bytes (measured by the second review: a 19 byte args prefix returned the test key's 1,000 CKB deposit).
   - `daoWeightAt(rpcUrl, lock, block)` in the reference code (2026-11-06) applies the three points above: deposits only, the exact lock, live at the block. Measured on testnet with a key of its own, two deposits of 200 and 300 CKB in block 22,983,301 and phase 1 of a withdrawal of the 200 CKB one in block 22,983,305: 0 CKB at block 22,983,300, 500 CKB from 22,983,301 to 22,983,304, and 300 CKB from 22,983,305, with the withdrawing cell returned apart. A lock whose args are the depositor's minus one byte weighs 0 CKB, while the indexer's prefix search finds the deposit for it.
   - A binding counts only when it was made before the snapshot block, and only when every cell dep out point its proof used (returned by `verify()`) was still live at the snapshot block. A key rotation, a recovery or a lock upgrade spends one of those cells; the owner then proves again. `depsLiveAt(rpcUrl, cellDeps, block)` in the reference code answers it from the node and its indexer (2026-11-05). Measured on testnet with a code cell an in-place upgrade spent in block 22,975,812: live at the snapshot block before, not live from that block on.
9. **Publish bindings.** Platforms SHOULD list active bindings publicly (lock hash, account, since when) and let a lock's owner revoke a binding by proving control.
10. **Cap the request.** Cap the size of the request that carries a proof (section 7).

## 10. What wallets show

A proof is a transaction. A wallet that shows it as one shows an input that does not exist, a u64::MAX amount, and an output holding the message, and the domain line then protects a user only if they read the output data.

Wallets SHOULD detect the proof shape: exactly one input, at index 0xffffffff, whose tx hash equals ckbhash(TAG || the wallet's lock hash || the message in the only output), and exactly one output, under that lock. `readProof(tx, lock)` in the reference code does this. A wallet that detects it SHOULD show a sign-in request, not a transfer: the domain next to the origin of the site asking (and a warning when they differ), the account, and the chain. It SHOULD NOT show the u64::MAX capacity as an amount being sent: nothing leaves the account.

## 11. VM and consensus

What was used here: ckb-debugger 1.1.1 (script version 2, cycle limit set to 70,000,000; its default is 3,500,000,000), run inside WSL on Windows, with cell deps read from `https://testnet.ckb.dev/rpc` on 2026-11-04 and 2026-11-05. The mock transaction format is ckb-debugger's.

ckb-debugger is a development tool. It picks the VM version from `hash_type` for `data`, `data1` and `data2` (measured: a program with a B extension instruction is refused under `data` and runs under `data1` and `data2`); for `type` it uses its `--script-version` option, not the chain's current epoch. A production verifier should embed `ckb-script` (the crate the node uses to verify scripts) with the target chain's consensus and the hardfork switch at the current epoch, so the VM version, syscalls and `hash_type` resolution match what the node would do for a real spend. Keep it in step with node upgrades.

`ward-vm` (in `vm/`, 2026-11-05) is that verifier's runner. It is built from the node's own crates at the tag mainnet and testnet ran that day (0.210.0, commit 2592ddf; `ckb-vm` 0.24.15, where the `ckb-script` on crates.io pins 0.24.14), loads the chain's bundled spec (which checks the genesis hash), and runs the lock group of input 0 for a transaction submitted at a tip in the epoch given, with only the node's syscalls. Measured against ckb-debugger: the eight vectors of section 13 give the same exit code and the same cycles under both, accepted and with one signature bit flipped. A program that calls syscall 9001, which ckb-debugger adds for development, exits 0 under the debugger and stops under `ward-vm` with `invalid syscall 9001`, as a node would. Move the tag in `vm/Cargo.toml` when the node moves.

`ckbVmJs` (2026-11-16) is a runner for a verifier with no process to start, a browser page among them. It hands the lock group of input 0 to [ckb-vm-js](https://github.com/Hanssen0-Alter-Ego/ckb-vm-js), which compiles the node's transaction verifier and CKB-VM to WebAssembly, with the consensus read from the node's `get_consensus` and the tip header from `get_tip_header`. Every cell is passed with an unknown origin, which changes nothing for a lock run alone. Measured with ckb-vm-js 0.2.0 from npm (2026-11-17): every vector of section 13 gives the same exit code as `ward-vm`, accepted and with one signature bit flipped, and the same cycles when accepted.

Node RPCs cannot do this check: `test_tx_pool_accept` and `estimate_cycles` both refuse the proof with `Unknown(OutPoint(...))` before any script runs.

## 12. Not covered

- **Relative or not-yet-matured time conditions.** The wallet can set the input's since to satisfy a matured absolute time lock, and the verifier runs the lock with it (measured: a since-gated lock refuses since 0 and accepts a satisfying since). A relative since has nothing to anchor to, as the input is fabricated. And the proof runs with the since the wallet sets, not the chain's time, so it shows the key controls the lock, not that an absolute time has passed: a platform that depends on the time must check it itself.
- **Locks whose signature does not cover the transaction hash.** Probe (b) refuses a witness that opens another message; a lock that signs something else could still pass it.
- **Locks that read the input's capacity.** They see u64::MAX. A lock that adds it to another amount could overflow. Lowering it to 2^63 would keep the capped-key guarantee with room to spare, but the quantum-resistant lock signs over the input cells, so changing the capacity would invalidate every such proof (measured: exit 107); it stays at u64::MAX.
- **Locks that need more than one input or more than one witness**, such as an owner lock that needs the owner's cell as a second input.
- **Type scripts.** Never run. The proof is about the lock only.
- **Mainnet.** V9 (secp256k1, 2026-11-05), V11 (JoyID, signed 2026-11-19), V16 (PW-lock) and V17 (the quantum-resistant lock, both 2026-11-06) are replayed by the tests against mainnet's cell deps, under ckb-debugger and under `ward-vm` with mainnet's consensus. The JoyID app on mainnet only accepts a requesting page served over https.
- **A production VM in production.** `ward-vm` (section 11) runs the node's script code under the chain's consensus, and every vector agrees with ckb-debugger under it. Running it for a platform, and moving its pin with node upgrades, is the platform's.

## 13. Locks tested

All on testnet unless the row says MAINNET, under the v1 rules (input at u64::MAX, both probes on): V5 to V8 and the Omnilock administrator rows on 2026-11-05, V12 to V17 on 2026-11-06, the rest on 2026-11-04. V1 to V9 and V12 to V17 were signed again on 2026-11-18 in the current form of the proof (section 4), and their rows give those runs. V10 and V11 are still in the earlier form. "Vector" means the signed proof is in `tests/vectors/` and replayed by the test suite; "test" means a test in this repository builds and signs the proof each run; "no" means a script outside this repository ran it once with random keys. Every accepted proof below also passed both probes.

| Lock | Signer | Result | Cycles | Controls, refused | In repo |
| --- | --- | --- | --- | --- | --- |
| secp256k1_blake160 | CCC private key signer | accepted | 1,631,945 | wrong key, exit -31 | V1 |
| secp256k1_blake160, MAINNET (2026-11-05) | CCC private key signer, mainnet cell deps | accepted | 1,656,592 | wrong key -31; flipped signature bit -31; a testnet platform, message names another chain | V9 |
| JoyID, main key, MAINNET (signed 2026-11-19) | JoyID app (app.joyid.dev), mainnet cell deps | accepted | 6,792,243 | flipped signature bit 11; another message 12; empty witness 4 | V11 |
| JoyID, main key | JoyID app (testnet.joyid.dev) | accepted | 6,817,974 | flipped signature bit, exit 11 | V2 |
| JoyID, sub key (2026-11-19) | JoyID app on a second device, through CCC's JoyID signer | accepted | 6,927,781 | flipped signature bit 11; the sub key list from before the device was added 13; the CoTA cell that list lived in, refused as not live | V10 |
| Cellula smart account, starter | software P-256 key, wallet's WebAuthn shape | accepted | 6,791,602 | wrong key, exit 26 | V3 |
| Cellula smart account, guarded | software P-256 key | accepted | 6,947,050 | wrong key 26; no Config Cell 21; forged Config Cell refused by rule 1 | V4 |
| Cellula smart account, guarded, with per-transaction caps | software P-256 keys, Config Cell fabricated in a local node stub | key with no cap accepted; keys capped at 100 and 1,000 CKB refused, exit 27 | about 6.8 million | key not in the Config Cell, exit 26 | test |
| Cellula smart account, starter and guarded | the Cellula wallet's own screen (testnet build, 2026-11-05): virtual passkeys, and one real phone passkey through the Cellula app | accepted | 6,750,745 to 6,900,939 | same nonce again; another account; another domain; signature byte 265 flipped, exit 26 | no |
| multisig 2-of-3 | CCC multisig signer, 2 members | accepted | 3,114,457 | one signature only -11; one key twice -52; a member and a non-member -52; flipped signature bit -52 | V5 |
| anyone-can-pay | CCC private key signer | accepted | 1,621,193 | no signature -2; another key -31; flipped signature bit -31 | V6 |
| Omnilock, Dogecoin mode | CCC Doge signer | accepted | 1,455,308 | another key -31; flipped signature bit -31 | V7 |
| Omnilock, Ethereum mode (2026-11-06), the lock CCC gives MetaMask | CCC EVM signer, the wallet's personal_sign done in software | accepted | 1,443,866 | another key -31; flipped signature bit -31 | V12 |
| Omnilock, Bitcoin mode (2026-11-06), the lock CCC gives UniSat and OKX | CCC BTC signer, the wallet's message signing done in software | accepted | 1,447,682 | another key -31; flipped signature bit -31 | V13 |
| PW-lock (2026-11-06), the lock Portal Wallet gave MetaMask users | CCC EVM signer (keccak256 sighash), the wallet's personal_sign done in software | accepted | 1,714,274 | another key -31; flipped signature bit -11 | V14 |
| PW-lock, MAINNET (2026-11-06) | as above, mainnet cell deps | accepted | 1,706,829 | another key -31; flipped signature bit -11 | V16 |
| Quantum-resistant lock (2026-11-06), Quantum Purse's deployment, one SLH-DSA-SHA2-128s key | software key, signed over the input at u64::MAX | accepted | 12,240,137 | another key 105; flipped signature bit 107 | V15 |
| Quantum-resistant lock, MAINNET (2026-11-06) | as above, mainnet cell deps | accepted | 11,610,050 | another key 105; flipped signature bit 107 | V17 |
| Omnilock, administrator mode, CCC's deployment | software keys, admin list cell fabricated in a local node stub | the lock accepts the admin's key (exit 0) and the owner's (exit 0); the verifier refuses both, rule 6 | about 1.5 million | not on the list 59; not on the list, naming the admin -31; no list cell 1 | test |
| Omnilock, administrator mode, 2022 deployment | as above | the lock accepts the admin's key (exit 0); the owner's stops the VM; the verifier refuses both, rule 6 | about 1.5 million | as above | test |
| Nostr lock | CCC Nostr signer | accepted | 4,168,745 | another key 26; flipped signature bit 18 | V8 |
| JoyID, main key | software P-256 key in JoyID's format | accepted | 6,729,097 | another key, exit 6 | no |
| always-success, assembled | none | refused by probe (a) | | accepted with the probes off | test |
| 4 byte password, assembled | the password | refused by probe (b) | | accepted with the probes off; empty witness exit 2 | test |

PW-lock and the quantum-resistant lock are most of the Nervos DAO depositors that a secp256k1 binding cannot count (926 and 5 of 1,132 at mainnet block 20,942,448). For PW-lock, CCC's `SignerEvm` lists an EVM wallet's PW-lock address next to its Omnilock one, so a site built on CCC can ask MetaMask for either. The quantum-resistant lock's message covers the input cells, so its wallet has to sign over the input as the verifier resolves it (capacity u64::MAX), a cell that is not on chain. Quantum Purse was not tested.

## 14. Rejected alternatives

### Variant B: a real input that cannot be spent yet

The v0 draft had a second template for wallets that look inputs up on chain: a live cell of the lock as the only input, with `since` = absolute block 2^56 - 1, and one output back to the lock, minus a 0.001 CKB fee, holding ckbhash(message). v1 removes it:

- **It satisfies time locks that have not matured.** The lock sees a since far in the future, which meets any "not before block X" condition. Measured with Omnilock in time-lock mode (unlock at block 10^12): variant B with the owner's key exits 0, while a real spend today exits -24.
- **It lets a capped key prove the account.** Its outflow is only the fee. Measured with the smart-account lock: a key capped at 10 CKB proved a 5,000 CKB cell (exit 0); the same key spending 4,999 CKB of that cell exits 27.
- **The input is a real cell and may carry a type script.** A lock that accepts when an input carries a given type (input-type proxy style) could be opened through the cell's type instead of the owner's key. Reasoning, not measured.
- **The wallet shows only a hash.** The message is on the transaction as ckbhash(message), so the domain line protects nobody.
- **It is not needed.** The JoyID app, the wallet it was meant for, signs the proof transaction (vector V2).

## Appendix: test vectors

Each vector below is also a JSON file in `tests/vectors/`. Transactions are in CCC's JSON form (camelCase); JSON RPC uses snake_case. Cell deps are testnet out points (V9, V11, V16 and V17: mainnet), and every vector is valid only while they stay live. V1 to V9 and V12 to V17 were signed on 2026-11-18 in the current form of the proof, and their expected results are from ckb-debugger 1.1.1 with deps read that day. V10 (2026-11-06) and V11 (2026-11-04) are still in the earlier form of section 4, and their file says so by having no `version`. V5 to V8 give the signed transaction in their file only. Exit codes are the lock's own; for V5 to V8 the name of each code in the lock's source is given where it explains the refusal. "Template check" means step 7 of section 5. The verifier resolves the input at capacity u64::MAX (section 4).

### V1. secp256k1

File: `tests/vectors/secp256k1.json`. Default CKB lock (secp256k1_blake160_sighash_all). Random key made for the test, signed with an unmodified CCC SignerCkbPrivateKey (prepareTransaction, signOnlyTransaction). Testnet, 2026-11-04. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  "hashType": "type",
  "args": "0x88ee5dbbe07c2bf2a854f9167c61fb4c974e0c4b"
}
```

Lock hash: `0x8a461d0118feb3e806513fe881f86ab2502ab4065c6386b380bd66cad2d92120`

Message (268 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-42
Lock hash: 0x8a461d0118feb3e806513fe881f86ab2502ab4065c6386b380bd66cad2d92120
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: a1b2c3
```

Out point tx hash P: `0x779cd7bde9cf9a5788f1fd7fabcb3ff2b32378958341ca35add24ef343d050af`

Transaction hash: `0x5a892db90a7f5192dee9a10893acaeab739e0a6162c0605d9e1e4fb6f2726df7`

Signed transaction (CCC JSON, camelCase):

```json
{
  "version": "0x0",
  "cellDeps": [
    {
      "outPoint": {
        "txHash": "0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37",
        "index": "0x0"
      },
      "depType": "depGroup"
    }
  ],
  "headerDeps": [],
  "inputs": [
    {
      "previousOutput": {
        "txHash": "0x779cd7bde9cf9a5788f1fd7fabcb3ff2b32378958341ca35add24ef343d050af",
        "index": "0xffffffff"
      },
      "since": "0x0"
    }
  ],
  "outputs": [
    {
      "capacity": "0x7a8fe2900",
      "lock": {
        "codeHash": "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
        "hashType": "type",
        "args": "0x88ee5dbbe07c2bf2a854f9167c61fb4c974e0c4b"
      }
    }
  ],
  "outputsData": [
    "0x64616f2e6578616d706c652077616e747320796f7520746f2070726f766520636f6e74726f6c206f66206120434b42206c6f636b2e0a4163636f756e743a20757365722d34320a4c6f636b20686173683a203078386134363164303131386665623365383036353133666538383166383661623235303261623430363563363338366233383062643636636164326439323132300a436861696e3a203078313036333965303839353530326235363838613662653863663639343630643736353431626661343832313632396438366436326261306161653366393630360a4973737565642061743a20323032362d31312d31385432303a30303a30305a0a4e6f6e63653a20613162326333"
  ],
  "witnesses": [
    "0x550000001000000055000000550000004100000012016793879450239438cb74d52a57938313f87f1a3ad6e709b2c0b7daa6f5a80d7e5ea25612c1ac01809f1f7b98dc12cad3f73b0cf07e043f679ea6357983ee01"
  ]
}
```

Expected:

- the proof: accepted, 1,631,945 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31
- bit 0 of witness byte 30 (inside the signature) flipped: lock exit -11 (`ERROR_SECP_RECOVER_PUBKEY`: with this signature the changed bytes recover no key; when they recover another key the exit is -31)
- `controls.wrongKey` (another key signed): lock exit -31
- probe (a), the same transaction with an empty witness: lock exit -2; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V2. JoyID, real app

File: `tests/vectors/joyid.json`. JoyID app on testnet (testnet.joyid.dev), main key, through @ckb-ccc/joy-id 1.2.6 CkbSigner.signOnlyTransaction. 2026-11-04. Signed again on 2026-11-18 in the current form of the proof: the same account, in the JoyID app on a phone, through an unmodified CCC JoyId.CkbSigner.

Lock:

```json
{
  "codeHash": "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac",
  "hashType": "type",
  "args": "0x000140911fa94eaef8c1d0eca81b23e1972ecb0548dc"
}
```

Lock hash: `0xd9d177037d0888e09330bf0dd18e98c534ea3479b4376911d0a5279ead21e0f8`

Message (289 bytes):

```text
cellula.id wants you to prove control of a CKB lock.
Account: ward-joyid-test
Lock hash: 0xd9d177037d0888e09330bf0dd18e98c534ea3479b4376911d0a5279ead21e0f8
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:59:07.443Z
Nonce: 08675c52b2cfa57d
```

Out point tx hash P: `0xb8ff23810403f5c534388e90d7aa1832ffea0d3aa4c96376cc65de4bf56ba4f1`

Transaction hash: `0xb235d219797456851194605cb88fc8524e5f9be0d1309a34337850192fb20b09`

Signed transaction (CCC JSON, camelCase):

```json
{
  "version": "0x0",
  "cellDeps": [
    {
      "outPoint": {
        "txHash": "0x4a596d31dc35e88fb1591debbf680b04a44b4a434e3a94453c21ea8950ffb4d9",
        "index": "0x0"
      },
      "depType": "code"
    },
    {
      "outPoint": {
        "txHash": "0x4a596d31dc35e88fb1591debbf680b04a44b4a434e3a94453c21ea8950ffb4d9",
        "index": "0x1"
      },
      "depType": "code"
    },
    {
      "outPoint": {
        "txHash": "0xf2c9dbfe7438a8c622558da8fa912d36755271ea469d3a25cb8d3373d35c8638",
        "index": "0x1"
      },
      "depType": "code"
    },
    {
      "outPoint": {
        "txHash": "0x95ecf9b41701b45d431657a67bbfa3f07ef7ceb53bf87097f3674e1a4a19ce62",
        "index": "0x1"
      },
      "depType": "code"
    },
    {
      "outPoint": {
        "txHash": "0x8b3255491f3c4dcc1cfca33d5c6bcaec5409efe4bbda243900f9580c47e0242e",
        "index": "0x1"
      },
      "depType": "code"
    }
  ],
  "headerDeps": [],
  "inputs": [
    {
      "previousOutput": {
        "txHash": "0xb8ff23810403f5c534388e90d7aa1832ffea0d3aa4c96376cc65de4bf56ba4f1",
        "index": "0xffffffff"
      },
      "since": "0x0"
    }
  ],
  "outputs": [
    {
      "capacity": "0x832156000",
      "lock": {
        "codeHash": "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac",
        "hashType": "type",
        "args": "0x000140911fa94eaef8c1d0eca81b23e1972ecb0548dc"
      }
    }
  ],
  "outputsData": [
    "0x63656c6c756c612e69642077616e747320796f7520746f2070726f766520636f6e74726f6c206f66206120434b42206c6f636b2e0a4163636f756e743a20776172642d6a6f7969642d746573740a4c6f636b20686173683a203078643964313737303337643038383865303933333062663064643138653938633533346561333437396234333736393131643061353237396561643231653066380a436861696e3a203078313036333965303839353530326235363838613662653863663639343630643736353431626661343832313632396438366436326261306161653366393630360a4973737565642061743a20323032362d31312d31385432303a35393a30372e3434335a0a4e6f6e63653a2030383637356335326232636661353764"
  ],
  "witnesses": [
    "0x6f010000100000006f0100006f0100005b01000001768ba2ab3ab54eb7f1a4c3f76ba1d6f1cf1532301ce310b77326e46b2e673086adaca74912a2cfa32ca0de2c3e4a77b4e386d11b36675d3f4b6734bc9490ffbf1333a513bca9394bcc3e468e4d1b1970314c4c43f3b5f491d8591aab4fcbd883752edba1af824f9005a3a9d7ca69f879d13d34b7c9a2883ca9c41c5a06bbf8a22b8b05e1f0303efb898fe4d6de601198c7a7b864abbe6a21c73b2e787e187c521d000000007b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224d5456694d324e6c4f57466b4d324d794e6a55354f444a6a4e54557a4d445269597a51334e5745354d5463774d6d4e694d3259795a4463304d544e684e6d55795957526d5a6a63314e446c6d4d444a6c4f4755795951222c226f726967696e223a2268747470733a2f2f746573746e65742e6a6f7969642e646576222c2263726f73734f726967696e223a66616c73657d"
  ]
}
```

Expected:

- the proof: accepted, 6,817,974 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 12
- bit 0 of witness byte 95 (inside the signature) flipped: lock exit 11
- probe (a), the same transaction with an empty witness: lock exit 4; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V3. Cellula smart account (starter)

File: `tests/vectors/smart-account-starter.json`. Cellula smart-account lock v6 on testnet, starter form (args 0x01 0xfe blake160(key)). Software P-256 key signing in the wallet's WebAuthn shape. 2026-11-04. Signed again on 2026-11-18 in the current form of the proof, with a new random key (the code cell is `0x71805f82…:0` since the lock's in-place upgrade of 2026-11-06, ckb-smart-account #2).

Lock:

```json
{
  "codeHash": "0x8f73d5d875b70c248c281052c9f67e2d7a2dbbee47a1ae71e68f44fed47b436e",
  "hashType": "type",
  "args": "0x01fe3b3c30a7c4e727ec89dbdd50f9e1f4209e18797d"
}
```

Lock hash: `0x3ce4c0ab9982772480b2f3bec8e480f1d6b6cfb41735b739711c12d1f1bbbcec`

Message (266 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-b2
Lock hash: 0x3ce4c0ab9982772480b2f3bec8e480f1d6b6cfb41735b739711c12d1f1bbbcec
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: n-b2
```

Out point tx hash P: `0xff004fca53faf7a416bc0fd2193c3d36344f0404947716a7ed890a8ab4a7b185`

Transaction hash: `0x69dbc99cbc87f8232f4311d2348ae8739e90202a0835bd92070bc9b049efc7bd`

Signed transaction (CCC JSON, camelCase):

```json
{
  "version": "0x0",
  "cellDeps": [
    {
      "outPoint": {
        "txHash": "0x71805f825021a3592c4d3cb8e0e8a372e62bfe45696d5abca35cd015e7dbfc1c",
        "index": "0x0"
      },
      "depType": "code"
    },
    {
      "outPoint": {
        "txHash": "0x98df7ead4a08964a086d07fe04ee93a2fb91670616e1b42ae9f405db358d3586",
        "index": "0x1"
      },
      "depType": "code"
    },
    {
      "outPoint": {
        "txHash": "0x98df7ead4a08964a086d07fe04ee93a2fb91670616e1b42ae9f405db358d3586",
        "index": "0x2"
      },
      "depType": "code"
    }
  ],
  "headerDeps": [],
  "inputs": [
    {
      "previousOutput": {
        "txHash": "0xff004fca53faf7a416bc0fd2193c3d36344f0404947716a7ed890a8ab4a7b185",
        "index": "0xffffffff"
      },
      "since": "0x0"
    }
  ],
  "outputs": [
    {
      "capacity": "0x7a8fe2900",
      "lock": {
        "codeHash": "0x8f73d5d875b70c248c281052c9f67e2d7a2dbbee47a1ae71e68f44fed47b436e",
        "hashType": "type",
        "args": "0x01fe3b3c30a7c4e727ec89dbdd50f9e1f4209e18797d"
      }
    }
  ],
  "outputsData": [
    "0x64616f2e6578616d706c652077616e747320796f7520746f2070726f766520636f6e74726f6c206f66206120434b42206c6f636b2e0a4163636f756e743a20757365722d62320a4c6f636b20686173683a203078336365346330616239393832373732343830623266336265633865343830663164366236636662343137333562373339373131633132643166316262626365630a436861696e3a203078313036333965303839353530326235363838613662653863663639343630643736353431626661343832313632396438366436326261306161653366393630360a4973737565642061743a20323032362d31312d31385432303a30303a30305a0a4e6f6e63653a206e2d6232"
  ],
  "witnesses": [
    "0x180200001000000018020000180200000402000000000200002526d5dde39a746b395b080806a8e2838aeef5b1377771cc4e5eec74ffaa9384050500000000007e7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a226b706a427a587050635146726a6e6959644948517268343352506f2d70656e3773357658485964346d7967222c226f726967696e223a2268747470733a2f2f77616c6c65742e746573746e65742e63656c6c756c612e6964227d3635bf032ea0a70fa3607983e68712fb51c0a0db972407e4e2303b07f9e1b7a860029eeaf2457bfc05fe9af6bdcc3b9e29f99a8a557596af5a899959dc609a684eb5d05d90ae33ef4c7818b431dd404738c4f5623f3dc216a469e50314bc25455d3dcf313f766128f630a12655668daae1713caa179d1bbf51b47ed65cf0367700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  ]
}
```

Expected:

- the proof: accepted, 6,791,602 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 26
- bit 0 of witness byte 265 (inside the signature) flipped: lock exit 26
- `controls.wrongKey` (another key signed): lock exit 26
- probe (a), the same transaction with an empty witness: lock exit 4; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V4. Cellula smart account (guarded)

File: `tests/vectors/smart-account-guarded.json`. Cellula smart-account lock v6 on testnet, guarded form (32 byte args, authenticators in a live Config Cell given as a cell dep). Software P-256 key as authenticator 0. 2026-11-04. Signed again on 2026-11-18 in the current form of the proof, with another account: a test wallet made through the Cellula wallet's own screens, whose software passkey is authenticator 0 of its live Config Cell (the code cell is `0x71805f82…:0` since the lock's in-place upgrade of 2026-11-06, ckb-smart-account #2).

Lock:

```json
{
  "codeHash": "0x8f73d5d875b70c248c281052c9f67e2d7a2dbbee47a1ae71e68f44fed47b436e",
  "hashType": "type",
  "args": "0xa0f23939addf955759cd4c99a8c589e07d5d1b98e8eae80dc8d73dc6e433b033"
}
```

Lock hash: `0x035c47d97f878d22318b0890a2e181d35c276855d718a60dd1cd71108dae89c8`

Message (264 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-b
Lock hash: 0x035c47d97f878d22318b0890a2e181d35c276855d718a60dd1cd71108dae89c8
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: n-b
```

Out point tx hash P: `0xd79285ec2e3750dbda1d6b7bd85b59159362123b613f008a37f7a5f32cc4d8a6`

Transaction hash: `0xa5fd2b846036b0667855f795b46a2d295b46df5f9c9630e8e6afd243295d3dc1`

Signed transaction (CCC JSON, camelCase):

```json
{
  "version": "0x0",
  "cellDeps": [
    {
      "outPoint": {
        "txHash": "0x71805f825021a3592c4d3cb8e0e8a372e62bfe45696d5abca35cd015e7dbfc1c",
        "index": "0x0"
      },
      "depType": "code"
    },
    {
      "outPoint": {
        "txHash": "0x98df7ead4a08964a086d07fe04ee93a2fb91670616e1b42ae9f405db358d3586",
        "index": "0x1"
      },
      "depType": "code"
    },
    {
      "outPoint": {
        "txHash": "0x98df7ead4a08964a086d07fe04ee93a2fb91670616e1b42ae9f405db358d3586",
        "index": "0x2"
      },
      "depType": "code"
    },
    {
      "outPoint": {
        "txHash": "0xb83886a360d55834ec094d844cf2c0788ee5b46f8eff2b2bc98f111d9a69f442",
        "index": "0x0"
      },
      "depType": "code"
    }
  ],
  "headerDeps": [],
  "inputs": [
    {
      "previousOutput": {
        "txHash": "0xd79285ec2e3750dbda1d6b7bd85b59159362123b613f008a37f7a5f32cc4d8a6",
        "index": "0xffffffff"
      },
      "since": "0x0"
    }
  ],
  "outputs": [
    {
      "capacity": "0x7d8ad3100",
      "lock": {
        "codeHash": "0x8f73d5d875b70c248c281052c9f67e2d7a2dbbee47a1ae71e68f44fed47b436e",
        "hashType": "type",
        "args": "0xa0f23939addf955759cd4c99a8c589e07d5d1b98e8eae80dc8d73dc6e433b033"
      }
    }
  ],
  "outputsData": [
    "0x64616f2e6578616d706c652077616e747320796f7520746f2070726f766520636f6e74726f6c206f66206120434b42206c6f636b2e0a4163636f756e743a20757365722d620a4c6f636b20686173683a203078303335633437643937663837386432323331386230383930613265313831643335633237363835356437313861363064643163643731313038646165383963380a436861696e3a203078313036333965303839353530326235363838613662653863663639343630643736353431626661343832313632396438366436326261306161653366393630360a4973737565642061743a20323032362d31312d31385432303a30303a30305a0a4e6f6e63653a206e2d62"
  ],
  "witnesses": [
    "0x180200001000000018020000180200000402000000000200002526d5dde39a746b395b080806a8e2838aeef5b1377771cc4e5eec74ffaa9384050500000000007e7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22535741746e77437a5838506c744a2d38756c7159573859554934362d36554a2d5948495864554d724a4b45222c226f726967696e223a2268747470733a2f2f77616c6c65742e746573746e65742e63656c6c756c612e6964227df221c6146080b1e76a1f007af7b57acdd51ffc8e7defc1c6929dcb0b0703cff7949a56edce5f68158d115660fd152e501ec86441709242a4ca350dd876587bfb3f922f5ea6c43abbb4eb5a67b69929813ddf3ae4ff53be06a4d3566507a3718720d527fe455a7ea2bc3562837cd7fbc6dc4fce5561694477b6ff553be492f95000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  ]
}
```

Expected:

- the proof: accepted, 6,947,050 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 26
- bit 0 of witness byte 265 (inside the signature) flipped: lock exit 26
- `controls.wrongKey` (another key signed): lock exit 26
- `controls.missingConfig` (right key, Config Cell dep left out): lock exit 21
- `controls.forgedConfig` (other key, forged Config Cell at an out point that does not exist): refused, cell dep not live; with the prover's copy of that dep the lock exits 0, which is why rule 1 exists
- probe (a), the same transaction with an empty witness: lock exit 4; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V5. secp256k1 multisig, 2 of 3

File: `tests/vectors/multisig.json`. secp256k1 multisig, 2 of 3 members (CCC `Secp256k1MultisigV2`, `hash_type` data1). Three random keys made for the test; members 0 and 2 signed with an unmodified CCC SignerMultisigCkbPrivateKey (prepareTransaction, signOnlyTransaction). Testnet, 2026-11-05. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0x36c971b8d41fbd94aabca77dc75e826729ac98447b46f91e00796155dddb0d29",
  "hashType": "data1",
  "args": "0xdd461f7d49231caef43a5099e73e926979b6c100"
}
```

Lock hash: `0xafde357355c67058bcc30eca8f9d22a4a1fb18de03a971e6013c407d06a212b2`

Message (266 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-ms
Lock hash: 0xafde357355c67058bcc30eca8f9d22a4a1fb18de03a971e6013c407d06a212b2
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: n-ms
```

Out point tx hash P: `0x342f7ce32fe75eb9f8f9685aade5072ac53eae2771b9d3cec167c9ff0c63ac2d`

Transaction hash: `0x99441715c7d90b993e7c3bf65a54b1f3c9a067a3d22e264728b0547a96a58009`

Cell deps: the multisig dep group `0x2eefdeb21f3a3edf697c28a52601b4419806ed60bb427420455cc29a090b26d5:0`.

Expected:

- the proof: accepted, 3,114,457 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -52 (`ERROR_VERIFICATION`, the recovered key is not a member)
- bit 0 of witness byte 124 (in the s half of signature 0) flipped: lock exit -52
- `controls.oneSignature` (member 0 alone, the second slot left as zeros, as CCC leaves it): lock exit -11 (`ERROR_SECP_RECOVER_PUBKEY` on the empty second slot)
- `controls.sameKeyTwice` (member 0's signature in both slots): lock exit -52 (`ERROR_VERIFICATION`, a member counts once)
- `controls.wrongKey` (member 0 and a key that is not a member): lock exit -52
- in all three controls the first slot is byte for byte the first signature of the accepted proof, so the refusal comes from the second slot
- probe (a), the same transaction with an empty witness: lock exit -2; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V6. anyone-can-pay

File: `tests/vectors/anyone-can-pay.json`. anyone-can-pay lock with the owner's key hash as args and no minimums. Random key made for the test, signed with an unmodified CCC SignerCkbPrivateKey (prepareTransaction, signOnlyTransaction), which signs anyone-can-pay inputs of its key. Testnet, 2026-11-05. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0x3419a1c09eb2567f6552ee7a8ecffd64155cffe0f1796e6e61ec088d740c1356",
  "hashType": "type",
  "args": "0xabbbf73f1fac20c13caac6abe85d94de2fbfe259"
}
```

Lock hash: `0x63a3ad448352566c0fa0d2b0ed81238e4ca676f1c7da1f5864d30d8222853234`

Message (268 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-acp
Lock hash: 0x63a3ad448352566c0fa0d2b0ed81238e4ca676f1c7da1f5864d30d8222853234
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: n-acp
```

Out point tx hash P: `0x9790ea28afcd35ce83f7bcfed17590c6f0d984394538d236e2c28e1780b5b6a7`

Transaction hash: `0x54f366d153ccaca690c31478ef8039a56d5f26a8fa4405cbd40dca4c03d37ad6`

Cell deps: the anyone-can-pay dep group `0xec26b0f85ed839ece5f11c4c4e837ec359f5adc4420410f6453b1f6b60fb96a6:0`.

Expected:

- the proof: accepted, 1,621,193 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31 (`ERROR_PUBKEY_BLAKE160_HASH`)
- bit 0 of witness byte 60 (in the s half of the signature) flipped: lock exit -31
- `controls.wrongKey` (another key signed the same sighash): lock exit -31
- `controls.noSignature` (empty witness): lock exit -2 (`ERROR_ENCODING`: with no signature the lock takes its payment path and pairs the input with the template's output, which is under the same lock; that output carries the message, and the path allows no data on a cell with no type). The capacity closes the path as well: with the data removed, the output holds less than the input and the lock exits -42 (`ERROR_OUTPUT_AMOUNT_NOT_ENOUGH`). The same empty witness on a transaction whose only output is under the lock, has no data and holds u64::MAX exits 0; the template check refuses that transaction (rule 2)
- probe (a), the same transaction with an empty witness: the `noSignature` line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V7. Omnilock, Dogecoin mode

File: `tests/vectors/omnilock-doge.json`. Omnilock with a Dogecoin identity (flag 0x05, no Omnilock modes). Random key made for the test, signed with an unmodified CCC SignerDogePrivateKey (prepareTransaction, signOnlyTransaction). Testnet, 2026-11-05. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb",
  "hashType": "type",
  "args": "0x05cec4b5a19c6b3bdbe5e7e171417bc01917b8b25700"
}
```

Lock hash: `0xb59fc9f560dcc145b41edd766e582062a626d3994cc4ce59f2a5ac2482e12d41`

Message (270 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-doge
Lock hash: 0xb59fc9f560dcc145b41edd766e582062a626d3994cc4ce59f2a5ac2482e12d41
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: n-doge
```

Out point tx hash P: `0x2794071300c7a13711deedcf7935148dc2d621fd217b771e1c8a448baa9961a6`

Transaction hash: `0x902b26d868fbc9b9d6b5723cdfe004b6cbc32492e8fd35cbcd15a4d21115c894`

Cell deps: the secp256k1 dep group `0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37:0` and the Omnilock code cell `0xec18bf0d857c981c3d1f4e17999b9b90c484b303378e94de1a57b0872f5d4602:0`.

Expected:

- the proof: accepted, 1,455,308 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31 (`ERROR_IDENTITY_PUBKEY_BLAKE160_HASH`)
- bit 0 of witness byte 80 (in the s half of the signature) flipped: lock exit -31
- `controls.wrongKey` (another Dogecoin key signed): lock exit -31
- probe (a), the same transaction with an empty witness: lock exit 71; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V8. Nostr lock

File: `tests/vectors/nostr.json`. Nostr lock (CCC `NostrLock`, no proof of work). Random key made for the test, signed with an unmodified CCC SignerNostrPrivateKey (prepareTransaction, signOnlyTransaction). The witness lock is a signed Nostr event, as JSON, with the sighash in a `ckb_sighash_all` tag. Testnet, 2026-11-05. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0x6ae5ee0cb887b2df5a9a18137315b9bdc55be8d52637b2de0624092d5f0c91d5",
  "hashType": "type",
  "args": "0x0027327da10f1cf62fc702f2097e8d8f12585890a3"
}
```

Lock hash: `0x2e1f0b9e3b96741726f2674345373665ebd023bda41a703efe8a523797a2ddf9`

Message (272 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-nostr
Lock hash: 0x2e1f0b9e3b96741726f2674345373665ebd023bda41a703efe8a523797a2ddf9
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: n-nostr
```

Out point tx hash P: `0xdf2bceabc0ed823a590faba90e02887da9ad4b5495d0e393c48297e55c788da2`

Transaction hash: `0x362fd749f66a29ecdb793da8be926b24ff1dfdfae30829c3eeaa3147b5256b94`

Cell deps: the Nostr lock code cell `0xa2a434dcdbe280b9ed75bb7d6c7d68186a842456aba0fc506657dc5ed7c01d68:0`.

Expected:

- the proof: accepted, 4,168,745 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 11 (`SighashAllMismatched`)
- bit 0 of witness byte 526 flipped (a hex digit of the signature's s half, `c` to `b`, so the event still parses): lock exit 18 (`ValidationFail`)
- `controls.wrongKey` (another Nostr key signed): lock exit 26 (`PubkeyNotFound`, the event's author is not the lock's key)
- probe (a), the same transaction with an empty witness: lock exit 4; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V9. secp256k1, mainnet

File: `tests/vectors/mainnet-secp256k1.json`. Default CKB lock on mainnet. Random key made for the test (no funds, never used again), signed with an unmodified CCC SignerCkbPrivateKey (prepareTransaction, signOnlyTransaction) against mainnet's cell deps, 2026-11-05. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  "hashType": "type",
  "args": "0xb12b0484873c510ce4a7e3fb9c174c8742f283fc"
}
```

Lock hash: `0x954107250caeb22e5778334e592fa89ea6a15ad4085aec2c0b3b9404e1a6c86e`

Message (268 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-42
Lock hash: 0x954107250caeb22e5778334e592fa89ea6a15ad4085aec2c0b3b9404e1a6c86e
Chain: 0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5
Issued at: 2026-11-18T20:00:00Z
Nonce: m1b2c3
```

Out point tx hash P: `0x6ca0d10b16f2562ead49722372bf789b3c5dcc3fe5b3edd7006bcb6a77cfa40e`

Transaction hash: `0x221116a5bc0b23a37cf36ae7a007ec0c48142d06a9304b69f89d688a7fcd95be`

Cell deps: mainnet's secp256k1 dep group `0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c:0`.

Expected, against mainnet (ckb-debugger, and `ward-vm` under mainnet's consensus, which agree):

- the proof: accepted, 1,656,592 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31
- bit 0 of witness byte 30 flipped: lock exit -31
- `controls.wrongKey` (a second random key signed): lock exit -31
- probe (a), the same transaction with an empty witness: lock exit -2
- a platform pinned to testnet: refused before any chain read, message names another chain
- `test_tx_pool_accept` on mainnet: refused, `Unknown(OutPoint(<P>ffffffff))`

### V10. JoyID, sub key

File: `tests/vectors/joyid-subkey.json`. The testnet account of V2 with a second device added on 2026-11-06: its passkey was made in a phone browser, which made it a sub key, and this proof was signed with it on 2026-11-19 in the JoyID app, in a desktop browser that holds the same passkey, through an unmodified CCC `JoyId.CkbSigner`. Its `prepareTransaction` adds the account's CoTA cell as the first cell dep and puts the sub key's SMT unlock entry in the witness's `output_type`.

Lock:

```json
{
  "codeHash": "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac",
  "hashType": "type",
  "args": "0x000140911fa94eaef8c1d0eca81b23e1972ecb0548dc"
}
```

Lock hash: `0xd9d177037d0888e09330bf0dd18e98c534ea3479b4376911d0a5279ead21e0f8`

Message (289 bytes):

```text
cellula.id wants you to prove control of a CKB lock.
Account: ward-joyid-test
Lock hash: 0xd9d177037d0888e09330bf0dd18e98c534ea3479b4376911d0a5279ead21e0f8
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-19T00:53:04.186Z
Nonce: e208701516bffec5
```

Out point tx hash P: `0xe0312c635ab2cb6c3264ebf4b606d909ef06a8df4f4bfc6c2868b96027af2290`

Transaction hash: `0xed9ef86a69cd01b437bae1521a683ed6c0a77da9210198159b92dbd8e8bd1c4d`

Cell deps: the account's CoTA cell `0x25bcc222f265419ebfb449f4849da33c1b03fa7cb7d8eea82ed0105336e20c4d:0` (33 bytes: a version byte and the root of the sub key list), then the five JoyID deps of V2.

Expected (ckb-debugger and `ward-vm` agree on every line):

- the proof: accepted, 6,927,781 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 12
- bit 0 of witness byte 95 flipped (inside the signature): lock exit 11
- the CoTA cell's data as it was before the device was added (`0x02` and 32 zero bytes, from the cell the device's registration spent, `0x5406dae922943df98f8ca5783bcf94468af044417cad4f900bf83d808a0d4862:1`): lock exit 13. A key that is not on the list cannot prove.
- the proof listing that spent cell instead: refused before the lock runs, the cell dep is not live; and `depsLiveAt` counts it live until the block that added the device, not from it
- probe (a), the same transaction with an empty witness: lock exit 4
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V11. JoyID, main key, mainnet

File: `tests/vectors/mainnet-joyid.json`. An account's main key on mainnet, signed in the JoyID app (app.joyid.dev, with the requesting page served over https) through an unmodified CCC `JoyId.CkbSigner`. Signed on 2026-11-19. It replaces the proof of 2026-11-04, which was in the earlier form and from another account.

Lock:

```json
{
  "codeHash": "0xd00c84f0ec8fd441c38bc3f87a371f547190f2fcff88e642bc5bf54b9e318323",
  "hashType": "type",
  "args": "0x0001dbda04783b21d6f72ab6f634c0bba5f4affb964c"
}
```

Lock hash: `0x20e8ed8e6e9361a17e34d5098f136b88b239516ca2775c6361f51587accb088a`

Message (289 bytes):

```text
cellula.id wants you to prove control of a CKB lock.
Account: ward-joyid-test
Lock hash: 0x20e8ed8e6e9361a17e34d5098f136b88b239516ca2775c6361f51587accb088a
Chain: 0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5
Issued at: 2026-11-19T00:58:30.507Z
Nonce: dcf35bd69c17711f
```

Out point tx hash P: `0x315c737e8c125c2ee36529377843f4b62cc2748007c54cff6db6b2b011612458`

Transaction hash: `0x2e7d8e988eb5c28959cc053cef07781e269c216dc2867af747220f48e02e5402`

Cell deps: the five JoyID deps on mainnet, `0x673e1843035ce9c249efc36b62865e7a7c9f6e2ca6fc9c66fd108307e81355f9:0` to `:4`.

Expected, against mainnet (ckb-debugger, and `ward-vm` under mainnet's consensus, which agree):

- the proof: accepted, 6,792,243 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 12
- bit 0 of witness byte 95 flipped (inside the signature): lock exit 11
- probe (a), the same transaction with an empty witness: lock exit 4
- `test_tx_pool_accept` on mainnet: refused, `Unknown(OutPoint(<P>ffffffff))`

### V12. Omnilock, Ethereum mode (MetaMask)

File: `tests/vectors/omnilock-ethereum.json`. Omnilock with an Ethereum identity (args 0x12, the address, 0x00), the lock CCC gives an EVM wallet such as MetaMask. Random key made for the test. CCC's `SignerEvm` prepares the transaction and places the signature; the wallet's part, `personal_sign` of `CKB transaction: <sighash>`, is done by ethers' `Wallet.signMessage`, the same algorithm. The MetaMask app itself was not driven. 2026-11-06. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb",
  "hashType": "type",
  "args": "0x1252777140f05ce2db61925c740032f0d7d951f7fd00"
}
```

Lock hash: `0x306450aa5f0528e0c2a18da57c6d826d1700854730d0eed37244a0faef43a8a5`

Message (268 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-evm
Lock hash: 0x306450aa5f0528e0c2a18da57c6d826d1700854730d0eed37244a0faef43a8a5
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: n-evm
```

Out point tx hash P: `0x46b1df790e63c1bdb792c9a2317741c45fa7d35d879c31d0c8da8158934ec4a8`

Transaction hash: `0x55ba799cd7163c19dc444c5e07133787711e5663c838cb59f179629e4b72a750`

Cell deps: the secp256k1 dep group `0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37:0` and the Omnilock code cell `0xec18bf0d857c981c3d1f4e17999b9b90c484b303378e94de1a57b0872f5d4602:0`, as CCC's testnet known scripts name them.

Expected:

- the proof: accepted, 1,443,866 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31 (`ERROR_IDENTITY_PUBKEY_BLAKE160_HASH`)
- bit 0 of witness byte 80 (in the s half of the signature) flipped: lock exit -31
- `controls.wrongKey` (another Ethereum key signed for this lock): lock exit -31
- probe (a), the same transaction with an empty witness: lock exit 71; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V13. Omnilock, Bitcoin mode (UniSat, OKX)

File: `tests/vectors/omnilock-bitcoin.json`. Omnilock with a Bitcoin identity (args 0x04, hash160 of the compressed key, 0x00), the lock CCC gives a Bitcoin wallet such as UniSat or OKX. Random key made for the test. CCC's `SignerBtc` prepares the transaction and places the signature; the wallet's part, ECDSA message signing of `CKB (Bitcoin Layer) transaction: <sighash>` with the Bitcoin message prefix, is done in software with the same algorithm. The wallet apps themselves were not driven. 2026-11-06. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb",
  "hashType": "type",
  "args": "0x045ab5c5b4dc355234aef88b409aef02950cabf9a200"
}
```

Lock hash: `0xed52b28187564f43b42eb964f7f25fde074b67915a93b929c7331cd5d3439545`

Message (268 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-btc
Lock hash: 0xed52b28187564f43b42eb964f7f25fde074b67915a93b929c7331cd5d3439545
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: n-btc
```

Out point tx hash P: `0xe8877f838786d78073d1bf1bc94946c26f7a062ee1f938ce538011d5eb98ab73`

Transaction hash: `0xb95d6837887ebabf4c9c2b9bab46c298931387d9048f79174265e7b245ed905d`

Cell deps: the secp256k1 dep group `0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37:0` and the Omnilock code cell `0xec18bf0d857c981c3d1f4e17999b9b90c484b303378e94de1a57b0872f5d4602:0`, as CCC's testnet known scripts name them.

Expected:

- the proof: accepted, 1,447,682 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31 (`ERROR_IDENTITY_PUBKEY_BLAKE160_HASH`)
- bit 0 of witness byte 80 (in the s half of the signature) flipped: lock exit -31
- `controls.wrongKey` (another Bitcoin key signed for this lock): lock exit -31
- probe (a), the same transaction with an empty witness: lock exit 71; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V14. PW-lock (Portal Wallet)

File: `tests/vectors/pw-lock.json`. PW-lock with an Ethereum address as args, the lock Portal Wallet gave MetaMask users. Random key made for the test. CCC's `SignerEvm` prepares the transaction and places the signature: it hashes the transaction with keccak256, and the wallet's part, `personal_sign` of those 32 bytes, is done by ethers' `Wallet.signMessage`, the same algorithm. The MetaMask app itself was not driven. 2026-11-06. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0x58c5f491aba6d61678b7cf7edf4910b1f5e00ec0cde2f42e0abb4fd9aff25a63",
  "hashType": "type",
  "args": "0xe7cdf7ad2619d3b5d0163ee7dd7673da3939ea56"
}
```

Lock hash: `0x9169449b8a9c581a7d0e952d45c429eeef92ace6d94c36345b364e1809bb4de9`

Message (266 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-pw
Lock hash: 0x9169449b8a9c581a7d0e952d45c429eeef92ace6d94c36345b364e1809bb4de9
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: n-pw
```

Out point tx hash P: `0xc0e34040ea5e03b30fdf3eef30428afdbfeba61632c7f3a573d8b0d2d973786e`

Transaction hash: `0x67bc94f23d2de1493df5740fbcf294771cb310dc2190f3fdebae717390529ef0`

Cell deps: the secp256k1 dep group `0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37:0` and the PW-lock code cell `0x57a62003daeab9d54aa29b944fc3b451213a5ebdf2e232216a3cfed0dde61b38:0`, as CCC's testnet known scripts name them.

Expected:

- the proof: accepted, 1,714,274 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31
- bit 0 of witness byte 30 (in the signature) flipped: lock exit -11
- `controls.wrongKey` (another key signed for this lock): lock exit -31
- probe (a), the same transaction with an empty witness: lock exit -44; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V15. Quantum-resistant lock (Quantum Purse)

File: `tests/vectors/quantum-lock.json`. The quantum-resistant lock (nervosnetwork/quantum-resistant-lock-script) with one SLH-DSA-SHA2-128s key, at the deployment Quantum Purse and the Cellula SDK both name. Random key made for the test. This lock's message covers the input cells, so the signature is made over the template's input as the verifier resolves it (capacity u64::MAX, no type, no data), with the Cellula SDK's `pqTxMessageAll` and `@noble/post-quantum`. No wallet app was driven. 2026-11-06. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0x147ecbb5c5127d982ee1362d2c2bb4267803da2eb006d150e88af6caaa0a7eaf",
  "hashType": "data1",
  "args": "0xbb668d5a90c33b38e00732f353c656479430d4ecee5d8e728ce19ca70a7a712e"
}
```

Lock hash: `0x1bb7716c7bee122d4e3e8e555ea4867e4b44951241e8093263b16be9316bb0fd`

Message (266 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-pq
Lock hash: 0x1bb7716c7bee122d4e3e8e555ea4867e4b44951241e8093263b16be9316bb0fd
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-18T20:00:00Z
Nonce: n-pq
```

Out point tx hash P: `0x8dc8a925a2c046c993b0045049bd93929e84e23f758a82df9a4762465e3f4ed4`

Transaction hash: `0x2c9d971960447862da2df0a670c16e21ea4ca6f394ae93dc5d83f73cd5f04613`

Cell deps: the lock's code cell `0x631d9a6049fb1fc3790e89d9daf35abe535b5e754cd8c3404319319710f0b106:0`, referred to by data hash (`data1`), as Quantum Purse's testnet build names it.

Expected:

- the proof: accepted, 12,240,137 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 107
- bit 0 of witness byte 100 (in the signature) flipped: lock exit 107
- `controls.wrongKey` (another key signed for this lock): lock exit 105
- probe (a), the same transaction with an empty witness: lock exit 106; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V16. PW-lock, mainnet

File: `tests/vectors/mainnet-pw-lock.json`. PW-lock with an Ethereum address as args, the lock Portal Wallet gave MetaMask users. Random key made for the test. CCC's `SignerEvm` prepares the transaction and places the signature: it hashes the transaction with keccak256, and the wallet's part, `personal_sign` of those 32 bytes, is done by ethers' `Wallet.signMessage`, the same algorithm. The MetaMask app itself was not driven. Mainnet cell deps, read only, nothing sent. 2026-11-06. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0xbf43c3602455798c1a61a596e0d95278864c552fafe231c063b3fabf97a8febc",
  "hashType": "type",
  "args": "0x6b74ad4dd6f6471b16fc2690e453426c995127cd"
}
```

Lock hash: `0xbf6889a43871918cce6078994b9877a414fd061a1a786c88aaba2601c9915351`

Message (266 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-pw
Lock hash: 0xbf6889a43871918cce6078994b9877a414fd061a1a786c88aaba2601c9915351
Chain: 0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5
Issued at: 2026-11-18T20:00:00Z
Nonce: n-pw
```

Out point tx hash P: `0x7c057012c6b0428e0ad3b9405c937f467805b5e9216c6be0b6315877b10aab57`

Transaction hash: `0x48238144c0129394ce891995c6fa7c11bb7a8dcc84a803dcde3fb8ae2022b890`

Cell deps: the secp256k1 dep group `0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c:0` and the PW-lock code cell `0x7534a9800b6722342044d4449693470560a13c37f8e560dfc0a82d6639be7f4b:0`, as CCC's mainnet known scripts name them.

Expected:

- the proof: accepted, 1,706,829 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31
- bit 0 of witness byte 30 (in the signature) flipped: lock exit -11
- `controls.wrongKey` (another key signed for this lock): lock exit -31
- probe (a), the same transaction with an empty witness: lock exit -44; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V17. Quantum-resistant lock, mainnet

File: `tests/vectors/mainnet-quantum-lock.json`. The quantum-resistant lock (nervosnetwork/quantum-resistant-lock-script) with one SLH-DSA-SHA2-128s key, at the deployment Quantum Purse and the Cellula SDK both name. Random key made for the test. This lock's message covers the input cells, so the signature is made over the template's input as the verifier resolves it (capacity u64::MAX, no type, no data), with the Cellula SDK's `pqTxMessageAll` and `@noble/post-quantum`. No wallet app was driven. Mainnet cell deps, read only, nothing sent. 2026-11-06. Signed again on 2026-11-18 in the current form of the proof, with a new random key.

Lock:

```json
{
  "codeHash": "0x302d35982f865ebcbedb9a9360e40530ed32adb8e10b42fbbe70d8312ff7cedf",
  "hashType": "type",
  "args": "0xece80dbdb04f83b7fc10105208165a4bb7e51fbd0c27bc7cd5ea4d5ad703bfda"
}
```

Lock hash: `0xbf7726cdd362b3f9da46248f0a442b01489c9e984182288e3b59c9b2f28befed`

Message (266 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-pq
Lock hash: 0xbf7726cdd362b3f9da46248f0a442b01489c9e984182288e3b59c9b2f28befed
Chain: 0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5
Issued at: 2026-11-18T20:00:00Z
Nonce: n-pq
```

Out point tx hash P: `0x580b04f6f9ab8587931b7361d201aa954c61629c72463b3656c2b8a843e79873`

Transaction hash: `0x50c8585c71c573973ae3fc68f1c055fc7e81368f24021abdd4c05830ef4e46fe`

Cell deps: the lock's code cell `0x4598d00df2f3dc8bc40eee38689a539c94f6cc3720b7a2a6746736daa60f500a:0`; the lock refers to it by type id (`0x302d3598…`), as Quantum Purse's mainnet build names it. On testnet the code is an older build (V15), so this vector is the one that runs the code mainnet depositors use.

Expected:

- the proof: accepted, 11,610,050 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 107
- bit 0 of witness byte 100 (in the signature) flipped: lock exit 107
- `controls.wrongKey` (another key signed for this lock): lock exit 105
- probe (a), the same transaction with an empty witness: lock exit 106; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`
