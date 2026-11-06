# Ward demo

A reference platform on testnet: any CKB wallet proves its lock, the platform binds the lock to an
account, and the Nervos DAO deposits under bound locks count in a test vote read at one snapshot
block. It runs at https://ward-demo.lusocryptolabs.com.

Votes run in cycles of 15 minutes. For the first 10, binding is open. Then a vote opens with its
snapshot at the tip, binding is frozen, and it closes 5 minutes later.

## The platform rules it follows (spec section 9)

| Rule | Where |
| --- | --- |
| 1. Issue and store the message | `/api/nonce` writes the message and stores it per nonce; `verify()` compares it byte for byte |
| 2. Tie the nonce to account and lock | the nonce row holds both |
| 3. Use once, burn early | `claimNonce`: `UPDATE ... WHERE used_at IS NULL`, before the first chain read |
| 4. Pass every field of E | `/api/bind` |
| 5. Pin the chain | testnet's genesis hash is a constant in `server.ts` |
| 6. One binding per lock | the lock hash is the primary key; binding it to another account moves it, and the moved binding weighs nothing for 20 minutes (the spec's example is 72 hours) |
| 7. Freeze during a vote | `/api/nonce`, `/api/bind` and `/api/unbind` answer 409 while a vote is open |
| 8. Weight | `daoWeightAt` at the snapshot block, for bindings made before it whose cell deps were live at it (`depsLiveAt`) |
| 9. Publish bindings | `/api/bindings` and the list on the page |
| 10. Cap the request | 64 KB |

The lock runs under `ward-vm`, built from `vm/` in the image, with testnet's consensus at the tip.

The wallet list is CCC's, with the Cellula wallet added before the other wallets (CCC keeps its own Khie on top) through a `SignersController` subclass (`src/main.tsx`, `CellulaWalletSigner` from `cellula-sdk`), since CCC does not list it yet.

## Run it

```sh
docker build -f demo/Dockerfile -t ward-demo .
docker run -p 8080:8080 -v ward-demo-data:/app/data -e DOMAIN=localhost:8080 ward-demo
```

Without Docker: build `vm/` (`cargo build --release`), then `cd demo && npm ci && npm run build`, and
from the repository root `DOMAIN=localhost:8080 WARD_VM=vm/target/release/ward-vm node demo/server.ts`.
`CYCLE_MS`, `BIND_MS` and `COOLDOWN_MS` shorten the cycle for a test.

Testnet only. Nothing on it sends a transaction.
