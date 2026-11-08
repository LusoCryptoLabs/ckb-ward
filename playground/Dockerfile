# The Ward playground: a gallery of runnable examples on testnet. Build context is the REPOSITORY
# ROOT, because the server runs the library from src/ and the lock runner is built from vm/.
#
#   docker build -f playground/Dockerfile -t ward-playground .
#   docker run -p 8080:8080 -v ward-play-data:/app/data -e DOMAIN=localhost:8080 ward-playground

# ward-vm, from source: the node's own script crates (vm/Cargo.toml pins the tag).
FROM rust:1-bookworm AS vm
WORKDIR /vm
COPY vm/ .
RUN cargo build --release --locked

# The page.
FROM node:24-bookworm-slim AS web
WORKDIR /app/playground
COPY playground/package.json playground/package-lock.json ./
RUN npm ci
COPY playground/ ./
# The browser-only examples import ../src/wallet.ts, so the library source must be present.
COPY src/ /app/src/
RUN npm run build

# The server: Node runs the TypeScript of src/ and playground/server.ts as it is.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/ src/
COPY playground/server.ts playground/
COPY --from=web /app/playground/dist playground/dist
COPY --from=vm /vm/target/release/ward-vm /usr/local/bin/ward-vm
ENV PORT=8080 DATA_DIR=/app/data WARD_VM=/usr/local/bin/ward-vm
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 8080
USER node
CMD ["node", "playground/server.ts"]
