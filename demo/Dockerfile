# The Ward demo: a reference platform on testnet. Build context is the REPOSITORY ROOT, because
# the server runs the library from src/ and the lock runner is built from vm/.
#
#   docker build -f demo/Dockerfile -t ward-demo .
#   docker run -p 8080:8080 -v ward-demo-data:/app/data -e DOMAIN=localhost:8080 ward-demo

# ward-vm, from source: the node's own script crates (vm/Cargo.toml pins the tag).
FROM rust:1-bookworm AS vm
WORKDIR /vm
COPY vm/ .
RUN cargo build --release --locked

# The page.
FROM node:24-bookworm-slim AS web
WORKDIR /app/demo
COPY demo/package.json demo/package-lock.json ./
RUN npm ci
COPY demo/ ./
RUN npm run build

# The server: Node runs the TypeScript of src/ and demo/server.ts as it is.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/ src/
COPY demo/server.ts demo/
COPY --from=web /app/demo/dist demo/dist
COPY --from=vm /vm/target/release/ward-vm /usr/local/bin/ward-vm
ENV PORT=8080 DATA_DIR=/app/data WARD_VM=/usr/local/bin/ward-vm
RUN mkdir -p /app/data && chown node:node /app/data
EXPOSE 8080
USER node
CMD ["node", "demo/server.ts"]
