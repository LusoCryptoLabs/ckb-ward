# CKB lock proof, v0

Status: draft. Prototype, tested on testnet only, not audited.

## 1. Purpose

A platform sometimes needs to know that the person behind one of its accounts controls a CKB lock. A governance site, for example, wants to count the Nervos DAO deposits held under a lock as that account's voting weight. Ethereum answers this with EIP-1271 for contract accounts and Bitcoin with BIP-322 for any script.

On CKB a lock is a program. A verifier that checks one signature scheme (secp256k1 with a known message prefix, say) cannot check a JoyID passkey, a multisig, an Omnilock in Dogecoin mode or a smart-account lock. Each new lock would need new verifier code and new wallet code.

This spec follows BIP-322: the prover signs a transaction that can never be committed, and the verifier runs the claimed lock on it. Every wallet that can sign an ordinary transaction for its lock can produce a proof, and one verifier handles every lock that signs the transaction hash.

A valid proof means: at verification time, the prover could produce a witness that makes the lock accept a transaction that commits to the message. It says nothing about type scripts and nothing about who controls the lock later.

## 2. Terms

- **ckbhash**: BLAKE2b-256 with personalization `ckb-default-hash`, the hash CKB uses for transaction and script hashes.
- **lock hash**: ckbhash of the molecule-serialized `Script`.
- **prover**: the person (and their wallet) who claims control of the lock.
- **verifier**: the platform's code that checks the proof.
- 1 CKB = 10^8 shannons.

## 3. Message

The verifier writes the message; the prover signs it as part of a transaction. UTF-8, lines separated by a single LF (0x0a), no trailing LF, at most 1024 bytes, exactly six lines:

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
| domain | host name of the platform, optional `:port`; letters, digits, `.` and `-` | A proof made for one platform is refused by another, because each verifier checks its own domain. Where the wallet shows the message, it also tells the user who is asking. |
| account | 1 to 256 characters, no control characters | Binds the proof to the account the lock is being linked to. A proof captured for account A cannot link the lock to account B. |
| lock hash | `0x` and 64 lowercase hex digits, the lock hash of the claimed lock | Lets the user see which lock is being proven. The verifier checks it equals the claimed lock's hash. |
| chain | `0x` and 64 lowercase hex digits, the genesis block hash | The same lock exists on every chain (a secp256k1 key has the same lock on testnet and mainnet). Without this a testnet proof would also be a mainnet proof. Testnet: `0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606`. Mainnet: `0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5`. |
| issued at | RFC 3339 in UTC with `Z`, optional fraction of a second, e.g. `2026-11-04T18:00:00Z` | The verifier refuses old proofs (section 8). |
| nonce | 1 to 128 characters from `A-Z a-z 0-9 . _ ~ -` | Chosen by the verifier, used once. A replayed proof is refused. Verifiers should use at least 64 random bits. |

The first line follows the shape of EIP-4361 (Sign-In with Ethereum) so it reads the same way to users who have seen that.

## 4. Variant A: an input that cannot exist

The preferred variant. The only input points at an out point that no transaction can create.

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

The input cell is resolved **by the verifier** to `{ capacity: 0, lock: the claimed lock, type: none, data: empty }`. The prover never supplies it.

Why these values:

- **index 0xffffffff.** No transaction can have 2^32 - 1 outputs within the block size limit, so the out point cannot exist. Nodes refuse the signed proof with `Unknown(OutPoint(...))` (measured with `test_tx_pool_accept` and `estimate_cycles`).
- **P commits to the tag, the lock and the message.** The tag keeps P apart from any real transaction hash. Another lock or another message gives another transaction, so a signature cannot be moved between them.
- **output capacity (41 + n) CKB.** That is the output's occupied capacity: 8 bytes of capacity, 32 of code hash, 1 of hash type, no args, then the data. CCC 1.19 and later raises an output below its occupied capacity to that value while building a transaction, so wallets built on CCC produce this value whatever the template said. The spec fixes it so every implementation builds the same bytes. Measured: the JoyID app signed a 329 CKB output for a 288 byte message.
- **output lock with an all-zero code hash.** Output locks never run. The output exists so wallets that show outputs show the message.

Signing. The wallet signs as it would any transaction spending a cell under the lock. A signer that needs the input cell (to size the witness placeholder or to find the lock) gets it from the template: CCC's `CellInput` carries `cellOutput` and `outputData` locally. A wallet that insists on looking up inputs on chain cannot sign variant A and uses variant B.

## 5. Variant B: a real input that cannot be spent yet

The fallback for wallets that resolve inputs from the chain. The prover picks a live cell C under the claimed lock.

| Field | Value |
| --- | --- |
| version | 0 |
| cell_deps | whatever the lock needs, chosen by the wallet |
| header_deps | empty |
| inputs | exactly one: `previous_output = ` out point of C, `since = 0x00ffffffffffffff` |
| outputs | exactly one: `capacity = C.capacity - 100000` shannons, `lock = ` the claimed lock, no type |
| outputs_data | exactly one: ckbhash(message), 32 bytes |
| witnesses | exactly one, as in variant A |

C must hold at least `(8 + 33 + args length + 32) * 10^8 + 100000` shannons so the output keeps its occupied capacity. The verifier reads C from the chain as a live cell and refuses when its lock is not the claimed lock.

Why these values:

- **since 0x00ffffffffffffff.** Flags 0x00 mean an absolute block number. The value is 2^56 - 1, a block the chain will not reach (more than 10^10 years at current block times). Nodes refuse the signed proof as `Immature` (measured). In JSON RPC form it is written `0xffffffffffffff`, because JSON RPC numbers have no leading zeros; ckb-debugger refuses `0x00ffffffffffffff`.
- **fee of 0.001 CKB.** With no fee the node refused the proof for its fee rate first (`PoolRejectedTransactionByMinFeeRate`, measured), so the since was never the reason given. With the fee, the reason is `Immature`. To the wallet it looks like an ordinary transfer to itself.
- **data = ckbhash(message).** The message is bound to the signature through the transaction hash. Only its hash is on the transaction, so a wallet cannot show the text.

Cost and risk. The prover signs a real spend of C, which the since keeps off chain. If C is spent before the verifier checks the proof, the proof is refused (input not live) and the prover signs a new one. Verifying variant B proves nothing extra about C: the platform should read the chain for the cells it counts.

## 6. Verifier algorithm

Input: the claimed lock L, the message M, the signed transaction T, the variant V. The verifier has a node RPC for its chain and a CKB-VM runner. Any refusal ends the check. Node errors mean "could not verify", not "refused".

1. Parse M (section 3). Refuse when malformed.
2. Refuse unless V is A or B.
3. Refuse unless the lock hash line equals the lock hash of L.
4. Platform checks: domain is the verifier's own; account is the account being linked; nonce is one the verifier issued for that account and has not seen used; `now - issued at` is within the verifier's window and `issued at` is not more than 60 seconds ahead of `now`.
5. Refuse unless T has exactly one witness and at most 16 cell deps (JoyID, the largest measured, uses 5).
6. Refuse unless the chain line equals the node's genesis hash (`get_block_hash(0)`).
7. Build the template, and the resolved input cell:
   - A: the template of section 4 from (L, M). The input cell is `{ capacity 0, L, no type, no data }`.
   - B: refuse unless T has exactly one input. Read that input's out point from the node as a live cell with data (`get_live_cell`). Refuse when it is not live or its lock is not L. Build the template of section 5 from that cell and M. The input cell is the live cell.
8. Copy T's cell deps into the template. Refuse unless the template's transaction hash equals T's. The transaction hash covers every field but the witnesses, so this one comparison checks every value in sections 4 and 5.
9. Read every cell dep of T from the node as a live cell with data. For a dep group, decode its data as an `OutPointVec` and read each member as a live cell too. Refuse when any is not live.
10. Run the lock script group of input 0 in CKB-VM with T, the resolved input and the resolved deps, under a cycle limit.
11. Accept when the lock exits 0. Then mark the nonce used and record (account, lock hash, chain, time).

## 7. Safety rules

Two rules found while building this. A verifier that breaks either accepts proofs it should refuse.

**Rule 1: cell deps come from the chain as live cells, never from the prover.** A lock's behaviour depends on its deps. For a lock with `hash_type` type, the code is found by type script hash, so a forged dep can carry any code. Some locks also read settings from deps. Measured with the Cellula smart-account lock, whose guarded form reads its authenticators from a Config Cell given as a cell dep: a proof signed by a key that is not an authenticator, sent with a forged copy of the Config Cell that lists that key, is **accepted** by the lock (exit 0) when the verifier uses the prover's copy. Read from the chain, the forged out point is not live and the proof is refused (vector V5, `forgedConfig`).

**Rule 2: the verifier builds the template.** If the verifier took any transaction whose input 0 is under L, the prover could add inputs, outputs or header deps that make L accept without the owner's key. Owner-lock style locks accept when another input carries a given lock hash. Proxy-lock style locks accept when a given cell is present. The anyone-can-pay lock accepts without a signature when an output under the same lock receives more. The template allows one input, one output and no header deps, so none of these paths opens. Measured with the template: the anyone-can-pay lock with no signature is refused (exit -44). The attacks with a prover-built transaction are reasoning, not measured here.

The input cell follows the same principle: in variant A it is a constant of the verifier, in variant B it is read live from the chain.

## 8. Replay and expiry

| Replay | Stopped by |
| --- | --- |
| the same proof sent again to the same verifier | nonce used once |
| a proof made for another platform | domain |
| a proof for another account on the same platform | account |
| a testnet proof on mainnet, or the reverse | chain line, checked against the node's genesis |
| a proof for another lock | lock hash line; in A the out point P commits to the lock hash; in B the input must be under the lock |
| an old proof | issued at window |
| the variant B transaction sent to the chain | the since cannot be reached |

The verifier only has to keep used nonces for as long as its window. 10 minutes is a reasonable window for an interactive flow.

A proof shows control at verification time. A key can be shared later, and for locks whose code can be upgraded (`hash_type` type) or whose settings live in cells (the smart account's Config Cell), the set of keys that control the lock can change after the proof. A platform that weighs votes long after linking can ask for a fresh proof per vote.

## 9. VM and consensus

What was used here: ckb-debugger 1.1.1 (script version 2, cycle limit set to 70,000,000; its default is 3,500,000,000), run inside WSL on Windows, with cell deps read from `https://testnet.ckb.dev/rpc` on 2026-11-04. The mock transaction format is ckb-debugger's.

ckb-debugger is a development tool. Its script version and cycle limit are defaults, not tied to any chain. A production verifier should embed `ckb-script` (the crate the node uses to verify scripts) with the target chain's consensus and the hardfork switch at the current epoch, so the VM version, syscalls and `hash_type` resolution (`data`, `data1`, `data2`, `type`) match what the node would do for a real spend. Keep it in step with node upgrades.

Node RPCs cannot do this check. For variant A, `test_tx_pool_accept` and `estimate_cycles` both refuse with `Unknown(OutPoint(...))` before any script runs. For variant B, `test_tx_pool_accept` answers `Immature` both for the valid proof and for one with a broken signature (measured), so its answer says nothing about the lock.

The verifier runs code chosen by the claimed lock, so it should cap cycles. The largest proof measured took 6,905,201 cycles (JoyID, real app).

## 10. Not covered

- **JoyID sub-keys.** Untested. Sub-key proofs depend on a CoTA cell dep.
- **Locks whose signature does not cover the transaction hash.** A witness made for another purpose might satisfy the template, and the proof would not be bound to the message.
- **Locks that read header deps or since.** The template has no header deps and a fixed since (0 in A, unreachable in B), so the result can differ from a real spend. Locks that read the input's capacity see 0 in variant A.
- **Locks that need more than one input or more than one witness**, such as an owner lock that needs the owner's cell as a second input.
- **Type scripts.** Never run. The proof is about the lock only.
- **What the user sees.** Wallets show the proof as a transaction. In variant A the message is visible only as output data, in variant B not at all. The domain line protects a user from phishing only where the wallet shows the message.
- **Mainnet.** Not tested.

## 11. Locks tested

All on testnet, 2026-11-04. "Vector" means the signed proof is in `tests/vectors/` and replayed by the test suite; the others were run once in the prototype and are not in this repository.

| Lock | Signer | Variant | Result | Cycles | Controls, refused | Vector |
| --- | --- | --- | --- | --- | --- | --- |
| secp256k1_blake160 | CCC private key signer | A | accepted | 1,645,417 | wrong key, exit -31 | V1 |
| JoyID, main key | JoyID app (testnet.joyid.dev) | A | accepted | 6,905,201 | flipped signature bit, exit 11 | V2 |
| JoyID, main key | JoyID app | B | accepted | 6,810,330 | flipped signature bit, exit 11 | V3 |
| Cellula smart account, starter | software P-256 key, wallet's WebAuthn shape | A | accepted | 6,772,215 | wrong key, exit 26 | V4 |
| Cellula smart account, guarded | software P-256 key | A | accepted | 6,755,723 | wrong key 26; no Config Cell 21; forged Config Cell refused by rule 1 | V5 |
| multisig 2-of-3 | software keys | A | accepted | 3,104,152 | one signature only, exit -11 | no |
| anyone-can-pay | software key | A | accepted | 1,629,337 | no signature -44; zeroed signature -11 | no |
| Omnilock, Dogecoin mode | software key | A | accepted | 1,444,984 | another key, exit -31 | no |
| Nostr lock | software key | A | accepted | 4,169,397 | another key, exit 26 | no |
| JoyID, main key | software P-256 key in JoyID's format | A | accepted | 6,758,225 | another key, exit 6 | no |

## Appendix: test vectors

Each vector below is also a JSON file in `tests/vectors/`. Transactions are in CCC's JSON form (camelCase); JSON RPC uses snake_case. Cell deps are testnet out points, and every vector is valid only while they stay live; V3 also needs its input cell to stay live. Expected results are from ckb-debugger 1.1.1 with deps read from testnet on 2026-11-04. Exit codes are the lock's own. "Template check" means step 8 of section 6.

### V1. secp256k1, variant A

File: `tests/vectors/secp256k1-a.json`. Default CKB lock (secp256k1_blake160_sighash_all). Random key made for the test, signed with an unmodified CCC SignerCkbPrivateKey (prepareTransaction, signOnlyTransaction). Testnet, 2026-11-04.

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
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V2. JoyID, variant A, real app

File: `tests/vectors/joyid-a.json`. JoyID app on testnet (testnet.joyid.dev), main key, through @ckb-ccc/joy-id 1.2.6 CkbSigner.signOnlyTransaction. 2026-11-04.

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
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V3. JoyID, variant B, real app

File: `tests/vectors/joyid-b.json`. JoyID app on testnet, main key, same session as joyid-a. The input is a 300 CKB testnet cell sent to the JoyID address for this test. The vector holds while that cell stays live. 2026-11-04.

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
Account: joyid-test-B
Lock hash: 0xd9d177037d0888e09330bf0dd18e98c534ea3479b4376911d0a5279ead21e0f8
Chain: 0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606
Issued at: 2026-11-04T16:44:50.089Z
Nonce: 0x29ebf433c800cf84
```

Input cell (live when signed and when tested): `0x1c3b3ff75a9864dc3f3ce4b96bec5eafc1975eb1b4f2750451af8d705c1a1f60:0`, capacity 300 CKB, no type, no data.

Transaction hash: `0x3f8b543eb64406e8efb8484524c42586f0324ec1298d5c6b08f2eddc1dc98180`

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
        "txHash": "0x1c3b3ff75a9864dc3f3ce4b96bec5eafc1975eb1b4f2750451af8d705c1a1f60",
        "index": "0x0"
      },
      "since": "0xffffffffffffff"
    }
  ],
  "outputs": [
    {
      "capacity": "0x6fc222560",
      "lock": {
        "codeHash": "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac",
        "hashType": "type",
        "args": "0x000140911fa94eaef8c1d0eca81b23e1972ecb0548dc"
      }
    }
  ],
  "outputsData": [
    "0xb65f59c002f909bcd483677cdc0a0d423113da2bbffe52ed90ad1fc3efd97cb1"
  ],
  "witnesses": [
    "0x6f010000100000006f0100006f0100005b01000001768ba2ab3ab54eb7f1a4c3f76ba1d6f1cf1532301ce310b77326e46b2e673086adaca74912a2cfa32ca0de2c3e4a77b4e386d11b36675d3f4b6734bc9490ffbf6953afee6d8ddb6a1b50f520d5eb4394927a40cc13f9de21ac079ebc83f7bcd70bd4b72478477b36f051517c1a165ebff5b91f8a2fe42b0e282ebf7f23e154e72b8b05e1f0303efb898fe4d6de601198c7a7b864abbe6a21c73b2e787e187c521d000000007b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224f4449354d47493259574a6b4d574d355a6a42694d6d51774e5755784d6a55304e6a686b59546734595467354e6d45354f54646c4d5755324d7a4d324e57566a4d444d7759574d314d32466b5a4449335a44526b4e77222c226f726967696e223a2268747470733a2f2f746573746e65742e6a6f7969642e646576222c2263726f73734f726967696e223a66616c73657d"
  ]
}
```

Expected:

- the proof: accepted, 6,810,330 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 12
- bit 0 of witness byte 95 (inside the signature) flipped: lock exit 11
- `test_tx_pool_accept` on the signed transaction: refused, `Immature(Inputs[0])`, and the same answer with the flipped signature

### V4. Cellula smart account (starter), variant A

File: `tests/vectors/smart-account-starter-a.json`. Cellula smart-account lock v6 on testnet, starter form (args 0x01 0xfe blake160(key)). Software P-256 key signing in the wallet's WebAuthn shape. 2026-11-04.

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
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`

### V5. Cellula smart account (guarded), variant A

File: `tests/vectors/smart-account-guarded-a.json`. Cellula smart-account lock v6 on testnet, guarded form (32 byte args, authenticators in a live Config Cell given as a cell dep). Software P-256 key as authenticator 0. 2026-11-04.

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

- the proof: accepted, 6,755,723 cycles
- the message with one more character in the nonce: refused by the template check; the same witness run on that message's template: lock exit 26
- bit 0 of witness byte 265 (inside the signature) flipped: lock exit 26
- `controls.wrongKey` (another key signed): lock exit 26
- `controls.missingConfig` (right key, Config Cell dep left out): lock exit 21
- `controls.forgedConfig` (other key, forged Config Cell at an out point that does not exist): refused, cell dep not live; with the prover's copy of that dep the lock exits 0, which is why rule 1 exists
- `test_tx_pool_accept` on the signed transaction: refused, `Unknown(OutPoint(<P>ffffffff))`
