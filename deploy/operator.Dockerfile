# The ZecDrop operator, for your own computer: `./zecdrop up` builds and runs this image (the README, "Make a payout").
# It holds your wallet and your payout lists, so it is never for a server: `./zecdrop` publishes its port on 127.0.0.1 only,
# and the operator refuses `--container` outside testnet.
# Build by hand:  docker build -f deploy/operator.Dockerfile -t zecdrop-operator .
# (deploy/operator.Dockerfile.dockerignore, not the root .dockerignore, decides what the build sees.)

# The web app the operator serves.
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
# The app bundles the example list and a few public receipts from these.
COPY examples /src/examples
COPY fixtures /src/fixtures
# Receipt and payslip links name the public site, which anyone can open and which checks them with its key-less verifier (the
# operator does not serve those checks). Build with --build-arg PUBLIC_SITE= to keep the links on your own computer instead.
ARG PUBLIC_SITE=https://zecdrop-site.vercel.app
RUN VITE_PUBLIC_RECEIPT_BASE_URL="$PUBLIC_SITE" npm run build

# The operator.
FROM rust:1.92-bookworm AS build
# protoc is needed by crates/drop-chain/build.rs (client generated from the .proto files at build time).
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Cargo needs every workspace member's manifest to resolve, so copy the whole crates/ tree.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# The caches make a rebuild after `./zecdrop update` far quicker than the first build.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p drop-operator \
    && cp target/release/drop-operator /usr/local/bin/drop-operator

FROM debian:bookworm-slim
# CA roots for the https gRPC endpoint.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/drop-operator /usr/local/bin/drop-operator
COPY --from=web /src/web/dist /app/web
# Your wallet and payouts live in /data, a folder of yours that `./zecdrop` mounts (~/.zecdrop-app), and the
# operator runs as you (`--user`), so the files there stay yours.
WORKDIR /data
EXPOSE 8787
ENTRYPOINT ["drop-operator"]
