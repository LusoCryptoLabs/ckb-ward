# Ward: lock proof for CKB, v1

Status: draft. Prototype, tested on testnet only.

v1 replaces the v0 draft after two reviews. Variant B is gone (section 14). The verifier resolves the proof input with capacity u64::MAX, runs two "no exclusive control" probes, and bounds its own work. Platforms get normative rules (section 9). The bytes a wallet signs for the remaining template did not change, so every v0 variant A proof is a v1 proof, and the domain tag stays `CKB lock proof v0\n` (section 4).

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
TAG = "CKB lock proof v0\n"                    (18 bytes, ASCII, ends with LF)
P   = ckbhash(TAG || lock hash || message)     (lock hash as 32 raw bytes, message as UTF-8)
n   = byte length of the message
```

| Field | Value |
| --- | --- |
| version | 0 |
| cell_deps | whatever the lock needs, chosen by the wallet |
| header_deps | empty |
| inputs | exactly one: `previous_output = { tx_hash: P, index: 0xffffffff }`, `since = 0` |
| outputs | exactly one: `capacity = (41 + n) * 10^8` shannons, `lock = { code_hash: 0x00 * 32, hash_type: "data", args: 0x }`, no type |
| outputs_data | exactly one: the message bytes |
| witnesses | exactly one: what the lock needs, as the wallet writes it (usually a `WitnessArgs` with the signature in `lock`) |

The input cell is resolved **by the verifier** to `{ capacity: 0xffffffffffffffff (u64::MAX), lock: the claimed lock, type: none, data: empty }`. The prover never supplies it. The template carries the same cell locally, so a signer computes the sighash without the chain and sees what the lock will see.

Why these values:

- **index 0xffffffff.** No transaction can have 2^32 - 1 outputs within the block size limit, so the out point cannot exist. Nodes refuse the signed proof with `Unknown(OutPoint(...))` (measured with `test_tx_pool_accept` and `estimate_cycles`).
- **P commits to the tag, the lock and the message.** The tag keeps P apart from any real transaction hash. Another lock or another message gives another transaction, so a signature cannot be moved between them.
- **The tag is versioned and kept.** It names the bytes of the signed transaction. v1 did not change them, so the tag stays `CKB lock proof v0\n` and v0 proofs keep their hashes. A later change to the signed bytes gets a new tag.
- **input capacity u64::MAX.** Some locks limit what a key may move in one transaction. The Cellula smart-account lock v6 lets the owner add keys with a per-transaction cap and counts as outflow what leaves the account. v0 resolved the input with capacity 0, so the outflow was only the (41 + n) CKB output, and a key capped at 1,000 CKB could prove the whole account (measured: exit 0). At u64::MAX the same key exits 27, over its cap, and a key with no cap exits 0 (measured, `tests/capped-key.test.ts`). The transaction hash covers out points, not the cells they resolve to, so no signed byte changed: every v0 vector verifies unchanged.
- **output capacity (41 + n) CKB.** That is the output's occupied capacity: 8 bytes of capacity, 32 of code hash, 1 of hash type, no args, then the data. CCC 1.19 and later raises an output below its occupied capacity to that value while building a transaction, so wallets built on CCC produce this value whatever the template said. The spec fixes it so every implementation builds the same bytes. Measured: the JoyID app signed a 329 CKB output for a 288 byte message.
- **output lock with an all-zero code hash.** Output locks never run. The output exists so wallets that show outputs show the message.

Signing. The wallet signs as it would any transaction spending a cell under the lock. A signer that needs the input cell (to size the witness placeholder or to find the lock) gets it from the template: CCC's `CellInput` carries `cellOutput` and `outputData` locally. A wallet that insists on looking up inputs on chain cannot sign the proof. The JoyID app signs it (vector V2).

## 5. Verifier algorithm

Input: the claimed lock L, the message M, the signed transaction T, and the platform's expectation E: the exact message it issued for this nonce, its own domain, the account, the nonce, the chain's genesis hash from its config, and the age window. Every field of E is required. The verifier has a node RPC for its chain and a CKB-VM runner. Any refusal ends the check. Node errors mean "could not verify", not "refused". Steps 1 to 7 read nothing from the chain.

1. Refuse when E or any field of it is missing.
2. Parse M (section 3). Refuse when malformed.
3. Refuse unless M equals E's message byte for byte.
4. Refuse unless the lock hash line equals the lock hash of L. Refuse when L is an Omnilock with the administrator flag (section 6, rule 6).
5. Refuse unless the domain, account, nonce and chain lines equal E's, `now - issued at` is within E's window, and `issued at` is not more than 60 seconds ahead of `now`.
6. Refuse unless T has exactly one witness, T's serialized size in a block (its bytes plus 4) is at most 597,000, the witness is at most 65,536 bytes, T lists at most 16 cell deps, and no out point appears twice among them (section 7).
7. Build the template of section 4 from (L, M) and copy T's cell deps into it. Refuse unless its transaction hash equals T's. The transaction hash covers every field but the witnesses, so this one comparison checks every value in section 4.
8. Claim the nonce (section 9, rule 3). Refuse when it was already used.
9. Refuse unless the node's genesis hash (`get_block_hash(0)`) equals E's chain.
10. Read every cell dep of T from the node as a live cell with data. For each dep group, read the member count from its data (an `OutPointVec`: a 4 byte count, then 36 bytes per out point). Refuse when the data is not that shape, or when all groups together list more than 32 cells, before reading any member. Then read each member not already read, as a live cell. Refuse when any cell is not live. Each read has a timeout.
11. Run the lock script group of input 0 in CKB-VM with T, the resolved input and the resolved deps, under a cycle limit. Refuse unless the lock exits 0.
12. Probe for exclusive control (section 6, rule 4). Run the lock again on (a) T with its witness replaced by an empty one, and (b) the template of M', which is M with the nonce replaced by a fresh random value, with T's cell deps and T's witness. Refuse when either exits 0.
13. Accept, and return the out points read in step 10. The binding records them (section 9, rule 8).

## 6. Safety rules

Each rule was found while building or reviewing this. A verifier that breaks one accepts proofs it should refuse.

**Rule 1: cell deps come from the chain as live cells, never from the prover.** A lock's behaviour depends on its deps. For a lock with `hash_type` type, the code is found by type script hash, so a forged dep can carry any code. Some locks also read settings from deps. Measured with the Cellula smart-account lock, whose guarded form reads its authenticators from a Config Cell given as a cell dep: a proof signed by a key that is not an authenticator, sent with a forged copy of the Config Cell that lists that key, is **accepted** by the lock (exit 0) when the verifier uses the prover's copy. Read from the chain, the forged out point is not live and the proof is refused (vector V4, `forgedConfig`).

**Rule 2: the verifier builds the template.** If the verifier took any transaction whose input 0 is under L, the prover could add inputs, outputs or header deps that make L accept without the owner's key. Owner-lock style locks accept when another input carries a given lock hash. Proxy-lock style locks accept when a given cell is present. The anyone-can-pay lock accepts without a signature when an output under the same lock receives more. The template allows one input, one output and no header deps, so none of these paths opens. Measured with the anyone-can-pay lock (vector V6): with no signature it refuses the template (exit -44, no output to pair the input with), and it accepts the same empty witness (exit 0) on a transaction whose only output is under the same lock and receives the input's whole capacity, which the template check refuses. The owner-lock and proxy-lock attacks are reasoning, not measured here.

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
| witness | 65,536 bytes; a verifier may raise it for a lock with larger signatures | The largest measured is 592 (Nostr lock, a signed event as JSON). It leaves room for post-quantum signatures: SLH-DSA 256f is 49,856 bytes by its parameter set (not measured here). |
| message | 1,024 bytes | Section 3. |
| each chain read | a timeout, 10 seconds by default | A slow or stalled node would hold the verifier. |
| each lock run | a cycle limit, 70,000,000 here | The largest proof measured took 6,905,201 cycles (JoyID, real app). |
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
   - A binding counts only when it was made before the snapshot block, and only when every cell dep out point its proof used (returned by `verify()`) was still live at the snapshot block. A key rotation, a recovery or a lock upgrade spends one of those cells; the owner then proves again.
9. **Publish bindings.** Platforms SHOULD list active bindings publicly (lock hash, account, since when) and let a lock's owner revoke a binding by proving control.
10. **Cap the request.** Cap the size of the request that carries a proof (section 7).

## 10. What wallets show

A proof is a transaction. A wallet that shows it as one shows an input that does not exist, a u64::MAX amount, and an output holding the message, and the domain line then protects a user only if they read the output data.

Wallets SHOULD detect the proof shape: exactly one input, at index 0xffffffff, whose tx hash equals ckbhash(TAG || the wallet's lock hash || the message in the only output), and exactly one output. `readProof(tx, lock)` in the reference code does this. A wallet that detects it SHOULD show a sign-in request, not a transfer: the domain next to the origin of the site asking (and a warning when they differ), the account, and the chain. It SHOULD NOT show the u64::MAX capacity as an amount being sent: nothing leaves the account.

## 11. VM and consensus

What was used here: ckb-debugger 1.1.1 (script version 2, cycle limit set to 70,000,000; its default is 3,500,000,000), run inside WSL on Windows, with cell deps read from `https://testnet.ckb.dev/rpc` on 2026-11-04 and 2026-11-05. The mock transaction format is ckb-debugger's.

ckb-debugger is a development tool. It picks the VM version from `hash_type` for `data`, `data1` and `data2` (measured: a program with a B extension instruction is refused under `data` and runs under `data1` and `data2`); for `type` it uses its `--script-version` option, not the chain's current epoch. A production verifier should embed `ckb-script` (the crate the node uses to verify scripts) with the target chain's consensus and the hardfork switch at the current epoch, so the VM version, syscalls and `hash_type` resolution match what the node would do for a real spend. Keep it in step with node upgrades.

`ward-vm` (in `vm/`, 2026-11-05) is that verifier's runner. It is built from the node's own crates at the tag mainnet and testnet ran that day (0.210.0, commit 2592ddf; `ckb-vm` 0.24.15, where the `ckb-script` on crates.io pins 0.24.14), loads the chain's bundled spec (which checks the genesis hash), and runs the lock group of input 0 for a transaction submitted at a tip in the epoch given, with only the node's syscalls. Measured against ckb-debugger: the eight vectors of section 13 give the same exit code and the same cycles under both, accepted and with one signature bit flipped. A program that calls syscall 9001, which ckb-debugger adds for development, exits 0 under the debugger and stops under `ward-vm` with `invalid syscall 9001`, as a node would. Move the tag in `vm/Cargo.toml` when the node moves.

Node RPCs cannot do this check: `test_tx_pool_accept` and `estimate_cycles` both refuse the proof with `Unknown(OutPoint(...))` before any script runs.

## 12. Not covered

- **JoyID sub-keys.** Untested. A sub-key proof adds the CoTA cell as a dep, which the verifier reads like any other. One attempt signed with the main key instead.
- **Locks with a time condition.** The template has since 0. Measured: an Omnilock in time-lock mode refuses it (exit -24), so such a lock cannot be proven with this template.
- **Locks whose signature does not cover the transaction hash.** Probe (b) refuses a witness that opens another message; a lock that signs something else could still pass it.
- **Locks that read header deps.** The template has none, so the result can differ from a real spend.
- **Locks that read the input's capacity.** They see u64::MAX. A lock that adds it to another amount could overflow and refuse an honest proof.
- **Locks that need more than one input or more than one witness**, such as an owner lock that needs the owner's cell as a second input.
- **Type scripts.** Never run. The proof is about the lock only.
- **Mainnet.** Checked once on 2026-11-04, not as vectors: a proof from a fresh secp256k1 key, and one from a JoyID account signed in the JoyID app, were both accepted against mainnet; replay, another account, one flipped signature byte and a testnet platform were refused, and the mainnet node refused the proof transaction (unknown out point). The JoyID app on mainnet only accepts a requesting page served over https.
- **A production VM in production.** `ward-vm` (section 11) runs the node's script code under the chain's consensus, and every vector agrees with ckb-debugger under it. Running it for a platform, and moving its pin with node upgrades, is the platform's.

## 13. Locks tested

All on testnet, under the v1 rules (input at u64::MAX, both probes on): V5 to V8 and the Omnilock administrator rows on 2026-11-05, the rest on 2026-11-04. "Vector" means the signed proof is in `tests/vectors/` and replayed by the test suite; "test" means a test in this repository builds and signs the proof each run; "no" means a script outside this repository ran it once with random keys. Every accepted proof below also passed both probes.

| Lock | Signer | Result | Cycles | Controls, refused | In repo |
| --- | --- | --- | --- | --- | --- |
| secp256k1_blake160 | CCC private key signer | accepted | 1,645,417 | wrong key, exit -31 | V1 |
| JoyID, main key | JoyID app (testnet.joyid.dev) | accepted | 6,905,201 | flipped signature bit, exit 11 | V2 |
| Cellula smart account, starter | software P-256 key, wallet's WebAuthn shape | accepted | 6,772,215 | wrong key, exit 26 | V3 |
| Cellula smart account, guarded | software P-256 key | accepted | 6,755,721 | wrong key 26; no Config Cell 21; forged Config Cell refused by rule 1 | V4 |
| Cellula smart account, guarded, with per-transaction caps | software P-256 keys, Config Cell fabricated in a local node stub | key with no cap accepted; keys capped at 100 and 1,000 CKB refused, exit 27 | about 6.8 million | key not in the Config Cell, exit 26 | test |
| Cellula smart account, starter and guarded | the Cellula wallet's own screen (testnet build, 2026-11-05): virtual passkeys, and one real phone passkey through the Cellula app | accepted | 6,750,745 to 6,900,939 | same nonce again; another account; another domain; signature byte 265 flipped, exit 26 | no |
| multisig 2-of-3 | CCC multisig signer, 2 members | accepted | 3,143,655 | one signature only -11; one key twice -52; a member and a non-member -52; flipped signature bit -52 | V5 |
| anyone-can-pay | CCC private key signer | accepted | 1,610,026 | no signature -44; another key -31; flipped signature bit -31 | V6 |
| Omnilock, Dogecoin mode | CCC Doge signer | accepted | 1,462,047 | another key -31; flipped signature bit -31 | V7 |
| Omnilock, administrator mode, CCC's deployment | software keys, admin list cell fabricated in a local node stub | the lock accepts the admin's key (exit 0) and the owner's (exit 0); the verifier refuses both, rule 6 | about 1.5 million | not on the list 59; not on the list, naming the admin -31; no list cell 1 | test |
| Omnilock, administrator mode, 2022 deployment | as above | the lock accepts the admin's key (exit 0); the owner's stops the VM; the verifier refuses both, rule 6 | about 1.5 million | as above | test |
| Nostr lock | CCC Nostr signer | accepted | 4,169,370 | another key 26; flipped signature bit 18 | V8 |
| JoyID, main key | software P-256 key in JoyID's format | accepted | 6,729,097 | another key, exit 6 | no |
| always-success, assembled | none | refused by probe (a) | | accepted with the probes off | test |
| 4 byte password, assembled | the password | refused by probe (b) | | accepted with the probes off; empty witness exit 2 | test |

## 14. Rejected alternatives

### Variant B: a real input that cannot be spent yet

The v0 draft had a second template for wallets that look inputs up on chain: a live cell of the lock as the only input, with `since` = absolute block 2^56 - 1, and one output back to the lock, minus a 0.001 CKB fee, holding ckbhash(message). v1 removes it:

- **It satisfies time locks that have not matured.** The lock sees a since far in the future, which meets any "not before block X" condition. Measured with Omnilock in time-lock mode (unlock at block 10^12): variant B with the owner's key exits 0, while a real spend today exits -24.
- **It lets a capped key prove the account.** Its outflow is only the fee. Measured with the smart-account lock: a key capped at 10 CKB proved a 5,000 CKB cell (exit 0); the same key spending 4,999 CKB of that cell exits 27.
- **The input is a real cell and may carry a type script.** A lock that accepts when an input carries a given type (input-type proxy style) could be opened through the cell's type instead of the owner's key. Reasoning, not measured.
- **The wallet shows only a hash.** The message is on the transaction as ckbhash(message), so the domain line protects nobody.
- **It is not needed.** The JoyID app, the wallet it was meant for, signs the proof transaction (vector V2).

## Appendix: test vectors

Each vector below is also a JSON file in `tests/vectors/`. Transactions are in CCC's JSON form (camelCase); JSON RPC uses snake_case. Cell deps are testnet out points, and every vector is valid only while they stay live. Expected results are from ckb-debugger 1.1.1 with deps read from testnet on 2026-11-04 (V1 to V4) and 2026-11-05 (V5 to V8). V5 to V8 give the signed transaction in their file only. Exit codes are the lock's own; for V5 to V8 the name of each code in the lock's source is given where it explains the refusal. "Template check" means step 7 of section 5. The verifier resolves the input at capacity u64::MAX (section 4); the signed bytes are the v0 ones.

### V1. secp256k1

File: `tests/vectors/secp256k1.json`. Default CKB lock (secp256k1_blake160_sighash_all). Random key made for the test, signed with an unmodified CCC SignerCkbPrivateKey (prepareTransaction, signOnlyTransaction). Testnet, 2026-11-04.

Lock:

```json
{
  "codeHash": "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  "hashType": "type",
  "args": "0xb8770a9bf89f93afbc373f0bd9971da6695ff899"
}
```

Lock hash: `0xd883ff1552061fbad61555ed77a9782620ce62c378551a7f945eab50f3827bed`

Message (268 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-42
Lock hash: 0xd883ff1552061fbad61555ed77a9782620ce62c378551a7f945eab50f3827bed
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-04T18:00:00Z
Nonce: a1b2c3
```

Out point tx hash P: `0xf11278536f43b8d885ecb78a0359836d779fce3ff422eaed31683f9574cd5684`

Transaction hash: `0x88c2695622e1a94ba45cbcfadbd273fd0f869b4c3110d7195e861d4e2beb63f4`

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
        "txHash": "0xf11278536f43b8d885ecb78a0359836d779fce3ff422eaed31683f9574cd5684",
        "index": "0xffffffff"
      },
      "since": "0x0"
    }
  ],
  "outputs": [
    {
      "capacity": "0x731c89500",
      "lock": {
        "codeHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "hashType": "data",
        "args": "0x"
      }
    }
  ],
  "outputsData": [
    "0x64616f2e6578616d706c652077616e747320796f7520746f2070726f766520636f6e74726f6c206f66206120434b42206c6f636b2e0a4163636f756e743a20757365722d34320a4c6f636b20686173683a203078643838336666313535323036316662616436313535356564373761393738323632306365363263333738353531613766393435656162353066333832376265640a436861696e3a203078313036333965303839353530326235363838613662653863663639343630643736353431626661343832313632396438366436326261306161653366393630360a4973737565642061743a20323032362d31312d30345431383a30303a30305a0a4e6f6e63653a20613162326333"
  ],
  "witnesses": [
    "0x550000001000000055000000550000004100000052fd4821af2bd4c650be0af49b365f5109bd273cf59770780bbfd6b8173eb1f424bc33e053adba1dd037deaf48a61e8f6305b3ae455a5074c4fcfede8c0ed47001"
  ]
}
```

Expected:

- the proof: accepted, 1,645,417 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31
- bit 0 of witness byte 30 (inside the signature) flipped: lock exit -31
- `controls.wrongKey` (another key signed): lock exit -31
- probe (a), the same transaction with an empty witness: lock exit -2; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V2. JoyID, real app

File: `tests/vectors/joyid.json`. JoyID app on testnet (testnet.joyid.dev), main key, through @ckb-ccc/joy-id 1.2.6 CkbSigner.signOnlyTransaction. 2026-11-04.

Lock:

```json
{
  "codeHash": "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac",
  "hashType": "type",
  "args": "0x000140911fa94eaef8c1d0eca81b23e1972ecb0548dc"
}
```

Lock hash: `0xd9d177037d0888e09330bf0dd18e98c534ea3479b4376911d0a5279ead21e0f8`

Message (288 bytes):

```text
cellula.id wants you to prove control of a CKB lock.
Account: joyid-test-A
Lock hash: 0xd9d177037d0888e09330bf0dd18e98c534ea3479b4376911d0a5279ead21e0f8
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-04T16:44:14.683Z
Nonce: 0x3b7247621cd1f86d
```

Out point tx hash P: `0x272911bef4b4f8f0f5a42a03d97183ccbcb3514ed06466aaf74f3230aa396441`

Transaction hash: `0x2fb5758ab82e92261e19339db183a377d4bb7b3bf7189268c58e5169e28a514b`

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
        "txHash": "0x272911bef4b4f8f0f5a42a03d97183ccbcb3514ed06466aaf74f3230aa396441",
        "index": "0xffffffff"
      },
      "since": "0x0"
    }
  ],
  "outputs": [
    {
      "capacity": "0x7a8fe2900",
      "lock": {
        "codeHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "hashType": "data",
        "args": "0x"
      }
    }
  ],
  "outputsData": [
    "0x63656c6c756c612e69642077616e747320796f7520746f2070726f766520636f6e74726f6c206f66206120434b42206c6f636b2e0a4163636f756e743a206a6f7969642d746573742d410a4c6f636b20686173683a203078643964313737303337643038383865303933333062663064643138653938633533346561333437396234333736393131643061353237396561643231653066380a436861696e3a203078313036333965303839353530326235363838613662653863663639343630643736353431626661343832313632396438366436326261306161653366393630360a4973737565642061743a20323032362d31312d30345431363a34343a31342e3638335a0a4e6f6e63653a20307833623732343736323163643166383664"
  ],
  "witnesses": [
    "0x6f010000100000006f0100006f0100005b01000001768ba2ab3ab54eb7f1a4c3f76ba1d6f1cf1532301ce310b77326e46b2e673086adaca74912a2cfa32ca0de2c3e4a77b4e386d11b36675d3f4b6734bc9490ffbfb36740a3d4cbfa798d31258285a274ab6265708656350a6779625fe8194dca43ec6fb2faf416c74e5bfd1020b50ff1a98909c42ba56f18357a4ecab55004141a2b8b05e1f0303efb898fe4d6de601198c7a7b864abbe6a21c73b2e787e187c521d000000007b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224e6a426c4f574a6d59324532597a646d5a47466a4e544d334d6d5a694f5751774d444a6a4d6a68695a6a51795a5455784e4745355932466d4d4759344e7a6b314d546778596d59324d3249774d4441334e6a677a4d41222c226f726967696e223a2268747470733a2f2f746573746e65742e6a6f7969642e646576222c2263726f73734f726967696e223a66616c73657d"
  ]
}
```

Expected:

- the proof: accepted, 6,905,201 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 12
- bit 0 of witness byte 95 (inside the signature) flipped: lock exit 11
- probe (a), the same transaction with an empty witness: lock exit 4; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V3. Cellula smart account (starter)

File: `tests/vectors/smart-account-starter.json`. Cellula smart-account lock v6 on testnet, starter form (args 0x01 0xfe blake160(key)). Software P-256 key signing in the wallet's WebAuthn shape. 2026-11-04.

Lock:

```json
{
  "codeHash": "0x8f73d5d875b70c248c281052c9f67e2d7a2dbbee47a1ae71e68f44fed47b436e",
  "hashType": "type",
  "args": "0x01fe06239af86a9f4f0469a249ad9fc6df2cb1a3949d"
}
```

Lock hash: `0xa61e6ae7be13a2ad287517b3fe280ee7c4c0893f6440a5864ae82e17bbcb4ce8`

Message (266 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-b2
Lock hash: 0xa61e6ae7be13a2ad287517b3fe280ee7c4c0893f6440a5864ae82e17bbcb4ce8
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-04T18:00:00Z
Nonce: n-b2
```

Out point tx hash P: `0x281844304af76c1c6a5d0d958b1886591976721dd3cedd2de0f90b724a9331a1`

Transaction hash: `0x0c83e2fc7ff8441c3be3c3fdbedfa925d529556f6714102ac00d2e3f2d6106b5`

Signed transaction (CCC JSON, camelCase):

```json
{
  "version": "0x0",
  "cellDeps": [
    {
      "outPoint": {
        "txHash": "0xbd1e24a9a96952e240a73699835a5a96865d1ee0b796fe43145782fd186ec5ad",
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
        "txHash": "0x281844304af76c1c6a5d0d958b1886591976721dd3cedd2de0f90b724a9331a1",
        "index": "0xffffffff"
      },
      "since": "0x0"
    }
  ],
  "outputs": [
    {
      "capacity": "0x725dcd300",
      "lock": {
        "codeHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "hashType": "data",
        "args": "0x"
      }
    }
  ],
  "outputsData": [
    "0x64616f2e6578616d706c652077616e747320796f7520746f2070726f766520636f6e74726f6c206f66206120434b42206c6f636b2e0a4163636f756e743a20757365722d62320a4c6f636b20686173683a203078613631653661653762653133613261643238373531376233666532383065653763346330383933663634343061353836346165383265313762626362346365380a436861696e3a203078313036333965303839353530326235363838613662653863663639343630643736353431626661343832313632396438366436326261306161653366393630360a4973737565642061743a20323032362d31312d30345431383a30303a30305a0a4e6f6e63653a206e2d6232"
  ],
  "witnesses": [
    "0x180200001000000018020000180200000402000000000200002526d5dde39a746b395b080806a8e2838aeef5b1377771cc4e5eec74ffaa9384050500000000007e7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a225152544e47764175615f70675045313076516e6556516b45526d38634f5f3833635962515656546d324263222c226f726967696e223a2268747470733a2f2f77616c6c65742e746573746e65742e63656c6c756c612e6964227da3805b0d3cbb721be936bbfe9d1f07890e1e422f7e80dae2157cd98dffbf2fb39650a42f8162cf67fa9f7671feb65cdecbc3bcf93730229e3e897dc03455bc7f4aa2d0f2885e409a4d700e1baea5d05d59b7bf98e0da27b30155d44045c61cba34267610e32089d03f7e3d53fe85f9917410b050d2586e24045db697b1aef7d900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  ]
}
```

Expected:

- the proof: accepted, 6,772,215 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 26
- bit 0 of witness byte 265 (inside the signature) flipped: lock exit 26
- `controls.wrongKey` (another key signed): lock exit 26
- probe (a), the same transaction with an empty witness: lock exit 4; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V4. Cellula smart account (guarded)

File: `tests/vectors/smart-account-guarded.json`. Cellula smart-account lock v6 on testnet, guarded form (32 byte args, authenticators in a live Config Cell given as a cell dep). Software P-256 key as authenticator 0. 2026-11-04.

Lock:

```json
{
  "codeHash": "0x8f73d5d875b70c248c281052c9f67e2d7a2dbbee47a1ae71e68f44fed47b436e",
  "hashType": "type",
  "args": "0x5d4646d76d06f56b57dbd848cbb0fd06ef7d0f67213d7c1ce02350fd73022934"
}
```

Lock hash: `0xb8533a06c264468007fa63c83d89e9d92dd326da1df59c9e266f690695869f7c`

Message (264 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-b
Lock hash: 0xb8533a06c264468007fa63c83d89e9d92dd326da1df59c9e266f690695869f7c
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-04T18:00:00Z
Nonce: n-b
```

Out point tx hash P: `0x3db1e6ab06f6cca101059dc32426aa2e11a3a702a731c613e2e10a1edc1b16cb`

Transaction hash: `0xaa26ca9b29b8fb58566e835f71d0d98cfa924a20174ebed71222d4bd1deaffee`

Signed transaction (CCC JSON, camelCase):

```json
{
  "version": "0x0",
  "cellDeps": [
    {
      "outPoint": {
        "txHash": "0xbd1e24a9a96952e240a73699835a5a96865d1ee0b796fe43145782fd186ec5ad",
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
        "txHash": "0x59ef1e1f6f0bbc3dd4419a98e3dab3e0d2d2a6305f7c6b620a90c9eaf00bcc39",
        "index": "0x2"
      },
      "depType": "code"
    }
  ],
  "headerDeps": [],
  "inputs": [
    {
      "previousOutput": {
        "txHash": "0x3db1e6ab06f6cca101059dc32426aa2e11a3a702a731c613e2e10a1edc1b16cb",
        "index": "0xffffffff"
      },
      "since": "0x0"
    }
  ],
  "outputs": [
    {
      "capacity": "0x719f11100",
      "lock": {
        "codeHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "hashType": "data",
        "args": "0x"
      }
    }
  ],
  "outputsData": [
    "0x64616f2e6578616d706c652077616e747320796f7520746f2070726f766520636f6e74726f6c206f66206120434b42206c6f636b2e0a4163636f756e743a20757365722d620a4c6f636b20686173683a203078623835333361303663323634343638303037666136336338336438396539643932646433323664613164663539633965323636663639303639353836396637630a436861696e3a203078313036333965303839353530326235363838613662653863663639343630643736353431626661343832313632396438366436326261306161653366393630360a4973737565642061743a20323032362d31312d30345431383a30303a30305a0a4e6f6e63653a206e2d62"
  ],
  "witnesses": [
    "0x180200001000000018020000180200000402000000000200002526d5dde39a746b395b080806a8e2838aeef5b1377771cc4e5eec74ffaa9384050500000000007e7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22597a4e43385a47325459675a534e49775377523456494531734d636b6769425a5f444e5f46503552357551222c226f726967696e223a2268747470733a2f2f77616c6c65742e746573746e65742e63656c6c756c612e6964227db07706b4b987f4128dce211584525fb7a99ea2bdf47992f2e5e7b5868daf1dd5c8657725d2e2915972f6cb3e82b425d519bd7798cb5fa89883cf83cade3af7165ca0b3cc805edfc788da236b5e58b1dd0c28bb0b339e6320be980e6b7ecd41a39465de3839e840f59c8b082e359dd9ce71ec5eb3b1ace2a3199a20cd8afedbf900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
  ]
}
```

Expected:

- the proof: accepted, 6,755,721 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 26
- bit 0 of witness byte 265 (inside the signature) flipped: lock exit 26
- `controls.wrongKey` (another key signed): lock exit 26
- `controls.missingConfig` (right key, Config Cell dep left out): lock exit 21
- `controls.forgedConfig` (other key, forged Config Cell at an out point that does not exist): refused, cell dep not live; with the prover's copy of that dep the lock exits 0, which is why rule 1 exists
- probe (a), the same transaction with an empty witness: lock exit 4; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V5. secp256k1 multisig, 2 of 3

File: `tests/vectors/multisig.json`. secp256k1 multisig, 2 of 3 members (CCC `Secp256k1MultisigV2`, `hash_type` data1). Three random keys made for the test; members 0 and 2 signed with an unmodified CCC SignerMultisigCkbPrivateKey (prepareTransaction, signOnlyTransaction). Testnet, 2026-11-05.

Lock:

```json
{
  "codeHash": "0x36c971b8d41fbd94aabca77dc75e826729ac98447b46f91e00796155dddb0d29",
  "hashType": "data1",
  "args": "0xf802e80ecc4c78fed3b8bbe8cdb7eb95db108087"
}
```

Lock hash: `0x7edc09c63cbc4a31a4accf4ce73609390670956c519b1023aa790e4e1d34d513`

Message (266 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-ms
Lock hash: 0x7edc09c63cbc4a31a4accf4ce73609390670956c519b1023aa790e4e1d34d513
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-05T12:00:00Z
Nonce: n-ms
```

Out point tx hash P: `0xa355a13ea6dd735b939988f53169961745a3df530f2fc3f089572acfc53e4754`

Transaction hash: `0x7103e88d47d02b2614cafd61f1d135b932c4dab3f94ced8463825113278eca82`

Cell deps: the multisig dep group `0x2eefdeb21f3a3edf697c28a52601b4419806ed60bb427420455cc29a090b26d5:0`.

Expected:

- the proof: accepted, 3,143,655 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -52 (`ERROR_VERIFICATION`, the recovered key is not a member)
- bit 0 of witness byte 124 (in the s half of signature 0) flipped: lock exit -52
- `controls.oneSignature` (member 0 alone, the second slot left as zeros, as CCC leaves it): lock exit -11 (`ERROR_SECP_RECOVER_PUBKEY` on the empty second slot)
- `controls.sameKeyTwice` (member 0's signature in both slots): lock exit -52 (`ERROR_VERIFICATION`, a member counts once)
- `controls.wrongKey` (member 0 and a key that is not a member): lock exit -52
- in all three controls the first slot is byte for byte the first signature of the accepted proof, so the refusal comes from the second slot
- probe (a), the same transaction with an empty witness: lock exit -2; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V6. anyone-can-pay

File: `tests/vectors/anyone-can-pay.json`. anyone-can-pay lock with the owner's key hash as args and no minimums. Random key made for the test, signed with an unmodified CCC SignerCkbPrivateKey (prepareTransaction, signOnlyTransaction), which signs anyone-can-pay inputs of its key. Testnet, 2026-11-05.

Lock:

```json
{
  "codeHash": "0x3419a1c09eb2567f6552ee7a8ecffd64155cffe0f1796e6e61ec088d740c1356",
  "hashType": "type",
  "args": "0x7cedbdb76a9575c711cdfd80c3527e2860c6dc83"
}
```

Lock hash: `0xcdebf3a1bd32f07a56f80d26f3a08a407275cbe9167b7ca673422251ca654bcb`

Message (268 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-acp
Lock hash: 0xcdebf3a1bd32f07a56f80d26f3a08a407275cbe9167b7ca673422251ca654bcb
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-05T12:00:00Z
Nonce: n-acp
```

Out point tx hash P: `0x2d20b60eb3b42e5eb419a7af928bf95c9126afed7ae1113528fbdb6e1e46d3d5`

Transaction hash: `0x9a9d9d90622c6fc31ad11b5ad3c062fa322962a7834d37ed2cab561955c723ce`

Cell deps: the anyone-can-pay dep group `0xec26b0f85ed839ece5f11c4c4e837ec359f5adc4420410f6453b1f6b60fb96a6:0`.

Expected:

- the proof: accepted, 1,610,026 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31 (`ERROR_PUBKEY_BLAKE160_HASH`)
- bit 0 of witness byte 60 (in the s half of the signature) flipped: lock exit -31
- `controls.wrongKey` (another key signed the same sighash): lock exit -31
- `controls.noSignature` (empty witness): lock exit -44 (`ERROR_NO_PAIR`: with no signature the lock takes its payment path, and the template has no output under the lock to pair the input with). The same empty witness on a transaction whose only output is under the lock and holds u64::MAX exits 0; the template check refuses that transaction (rule 2)
- probe (a), the same transaction with an empty witness: the `noSignature` line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V7. Omnilock, Dogecoin mode

File: `tests/vectors/omnilock-doge.json`. Omnilock with a Dogecoin identity (flag 0x05, no Omnilock modes). Random key made for the test, signed with an unmodified CCC SignerDogePrivateKey (prepareTransaction, signOnlyTransaction). Testnet, 2026-11-05.

Lock:

```json
{
  "codeHash": "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb",
  "hashType": "type",
  "args": "0x050ffa745d9c337cf15ef4ee5b5dc8672ea19b3fa900"
}
```

Lock hash: `0x4bc158c10fca14a6cca6e5273ea5db0bb3d06ad0b3b508bb5aa48a910f6ef2c3`

Message (270 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-doge
Lock hash: 0x4bc158c10fca14a6cca6e5273ea5db0bb3d06ad0b3b508bb5aa48a910f6ef2c3
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-05T12:00:00Z
Nonce: n-doge
```

Out point tx hash P: `0x8411e47ff60f74930665baf4e1661f2ce96fc5433beaca09dbcf425da97190b0`

Transaction hash: `0x55b606e6d199884215b75ebd906ee9f04362af2f26520a31d62a5a2db8e33c3e`

Cell deps: the secp256k1 dep group `0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37:0` and the Omnilock code cell `0xec18bf0d857c981c3d1f4e17999b9b90c484b303378e94de1a57b0872f5d4602:0`.

Expected:

- the proof: accepted, 1,462,047 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit -31 (`ERROR_IDENTITY_PUBKEY_BLAKE160_HASH`)
- bit 0 of witness byte 80 (in the s half of the signature) flipped: lock exit -31
- `controls.wrongKey` (another Dogecoin key signed): lock exit -31
- probe (a), the same transaction with an empty witness: lock exit 71; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V8. Nostr lock

File: `tests/vectors/nostr.json`. Nostr lock (CCC `NostrLock`, no proof of work). Random key made for the test, signed with an unmodified CCC SignerNostrPrivateKey (prepareTransaction, signOnlyTransaction). The witness lock is a signed Nostr event, as JSON, with the sighash in a `ckb_sighash_all` tag. Testnet, 2026-11-05.

Lock:

```json
{
  "codeHash": "0x6ae5ee0cb887b2df5a9a18137315b9bdc55be8d52637b2de0624092d5f0c91d5",
  "hashType": "type",
  "args": "0x0038acc98818377c58e8e189f484e09a4a896a5814"
}
```

Lock hash: `0x3ac94bc0a8ef71ca2455f07dc04dfa5b835ea42a9dbef4c98a70db487b65efc6`

Message (272 bytes):

```text
dao.example wants you to prove control of a CKB lock.
Account: user-nostr
Lock hash: 0x3ac94bc0a8ef71ca2455f07dc04dfa5b835ea42a9dbef4c98a70db487b65efc6
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-05T12:00:00Z
Nonce: n-nostr
```

Out point tx hash P: `0x3dfe2a707bc10ad2e9e1fc9703819b6a36c811f82829322e054f97ca7376953b`

Transaction hash: `0x8e9e64c5fb4efee64483a9e9d67130631c619995cc0b5d0ea3caf7359e9140c8`

Cell deps: the Nostr lock code cell `0xa2a434dcdbe280b9ed75bb7d6c7d68186a842456aba0fc506657dc5ed7c01d68:0`.

Expected:

- the proof: accepted, 4,169,370 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 11 (`SighashAllMismatched`)
- bit 0 of witness byte 526 flipped (a hex digit of the signature's s half, `c` to `b`, so the event still parses): lock exit 18 (`ValidationFail`)
- `controls.wrongKey` (another Nostr key signed): lock exit 26 (`PubkeyNotFound`, the event's author is not the lock's key)
- probe (a), the same transaction with an empty witness: lock exit 4; probe (b) is the other-message line above
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`
