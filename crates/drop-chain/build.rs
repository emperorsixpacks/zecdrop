//! Generates the lightwalletd gRPC client from the upstream `.proto` files in `proto/`.
//!
//! Requires `protoc` on the PATH (or in `PROTOC`). Only the client is generated: this
//! crate never serves the protocol.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=proto");
    tonic_prost_build::configure()
        .build_server(false)
        .compile_protos(
            &["proto/service.proto", "proto/compact_formats.proto"],
            &["proto"],
        )?;
    Ok(())
}
