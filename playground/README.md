# Ward playground

Runnable examples of Ward, the way [app.ckbccc.com](https://app.ckbccc.com) is for CCC. A wallet
connects, signs a proof, and the server runs the lock in CKB-VM to check it. Testnet, nothing is
sent to the chain.

Live on testnet: [ward-play.lusocryptolabs.com](https://ward-play.lusocryptolabs.com).

Examples:

- **Prove a lock.** Any wallet proves it controls its lock. The server reports the exit code, the
  cycles, and the cell deps the lock ran with.
- **Sign in.** A session, issued only after the proof checks out. This is what EIP-1271 does on
  Ethereum and BIP-322 on Bitcoin, for every CKB lock.
- **Read a proof.** How a wallet recognises a proof request and shows the domain, not a transfer.
  Runs in the browser with `readProof` from `ckb-ward/wallet`.
- **Message and template.** The message and the unsendable transaction, built as you type, in the
  browser.

## Run it

The page is a static build; the server runs the library from `../src` and needs `ward-vm` (see the
[top README](../README.md#lock-runner)).

```sh
npm ci && npm run build          # the page, into dist/
cd ..                            # repo root
DOMAIN=localhost:8080 WARD_VM=path/to/ward-vm node playground/server.ts
```

Or with Docker. The build context is the repository root, because the server runs `src/` and the
runner is built from `vm/`:

```sh
docker build -f playground/Dockerfile -t ward-playground .
docker run -p 8080:8080 -v ward-play-data:/app/data -e DOMAIN=localhost:8080 ward-playground
```
