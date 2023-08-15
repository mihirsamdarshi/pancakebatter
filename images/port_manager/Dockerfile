FROM rust:1.71.1-alpine3.18 as builder
RUN apk add --no-cache musl-dev

# Set `SYSROOT` to a dummy path (default is /usr) because pkg-config-rs *always*
# links those located in that path dynamically but we want static linking, c.f.
# https://github.com/rust-lang/pkg-config-rs/blob/54325785816695df031cef3b26b6a9a203bbc01b/src/lib.rs#L613
ENV SYSROOT=/dummy

WORKDIR /app
COPY gluetun-port-mgr .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release

FROM alpine as runner
COPY --from=builder /app/target/release/gluetun-port-mgr ./gluetun-port-mgr
CMD ["./gluetun-port-mgr"]

LABEL org.opencontainers.image.authors="Mihir Samdarshi"
LABEL org.opencontainers.image.description="Simple program that reads a text file and sends the port written to that file by Gluetun to an application."
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/mihirsamdarshi/pancakebatter"
LABEL org.opencontainers.image.title="Gluetun Port Manager"
