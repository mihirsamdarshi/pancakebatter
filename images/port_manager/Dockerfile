# syntax=docker/dockerfile:1.6-labs
FROM rust:1.74.1-alpine3.18 as builder
RUN apk add --no-cache musl-dev

# Set `SYSROOT` to a dummy path (default is /usr) because pkg-config-rs *always*
# links those located in that path dynamically but we want static linking, c.f.
# https://github.com/rust-lang/pkg-config-rs/blob/54325785816695df031cef3b26b6a9a203bbc01b/src/lib.rs#L613
ENV SYSROOT=/dummy

RUN cargo new --bin /app
COPY gluetun-port-mgr/Cargo.toml gluetun-port-mgr/Cargo.lock /app/
WORKDIR /app
# This step compiles only our dependencies and saves them in a layer. This is the most impactful time savings
# Note the use of --mount=type=cache. On subsequent runs, we'll have the crates already downloaded
RUN --mount=type=cache,target=/usr/local/cargo/registry cargo build --release

COPY gluetun-port-mgr/src/ src/
RUN --mount=type=cache,target=/usr/local/cargo/registry <<EOF
  set -e
  # update timestamps to force a new build
  touch /app/src/main.rs
  cargo build --release
EOF

FROM alpine:3.18.5 as runner

RUN apk add --no-cache iptables

COPY --from=builder /app/target/release/gluetun-port-mgr ./gluetun-port-mgr
CMD ["./gluetun-port-mgr"]

LABEL org.opencontainers.image.authors="Mihir Samdarshi"
LABEL org.opencontainers.image.description="Simple program that reads a text file and sends the port written to that file by Gluetun to an application."
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/mihirsamdarshi/pancakebatter"
LABEL org.opencontainers.image.title="Gluetun Port Manager"
