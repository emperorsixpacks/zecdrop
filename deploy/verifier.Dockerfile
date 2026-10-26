# Hosted, key-less verifier (crates/drop-verifier). Stateless: no volume, no secrets.
# Build:  docker build -f deploy/verifier.Dockerfile -t zecdrop-verifier .
# Run:    docker run --rm -p 8080:8080 -e PORT=8080 \
#           -e TESTNET_ENDPOINT=https://testnet.zec.rocks:443 \
#           -e CORS_ORIGIN=https://your-receipt-site.example zecdrop-verifier
FROM rust:1.92-bookworm AS build
# protoc is needed by crates/drop-chain/build.rs (client generated from the .proto files at build time).
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Cargo needs every workspace member's manifest to resolve, so copy the whole crates/ tree.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --locked -p drop-verifier

FROM debian:bookworm-slim
# CA roots for the https gRPC endpoint.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --shell /usr/sbin/nologin verifier
COPY --from=build /src/target/release/drop-verifier /usr/local/bin/drop-verifier
USER verifier
ENV PORT=8080 TESTNET_ENDPOINT=https://testnet.zec.rocks:443
EXPOSE 8080
# The verifier holds no keys and no state, so a public bind is intended here.
# Mainnet is opt-in: add `--mainnet-endpoint https://zec.rocks:443` to the command.
CMD ["sh", "-c", "exec drop-verifier --bind 0.0.0.0:${PORT} --testnet-endpoint ${TESTNET_ENDPOINT} ${CORS_ORIGIN:+--cors-origin ${CORS_ORIGIN}}"]
