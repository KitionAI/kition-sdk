# syntax=docker/dockerfile:1
# Context is produced by assemble-context.mjs; see README.md.
FROM rust:1.95-bookworm AS build
WORKDIR /src
COPY sdk/ ./
RUN cargo build --locked --release -p kition-kits --bin kition-kits-mcp

FROM debian:bookworm-slim AS runtime
# GNU/Linux kit binaries must need only these system libraries or ship their
# remaining dependencies in their bundle. No downloads happen at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgcc-s1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 kition \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /run/kition kition \
    && mkdir -p /workspace /run/kition \
    && chown 10001:10001 /workspace /run/kition \
    && chmod 0700 /run/kition
COPY --from=build /src/target/release/kition-kits-mcp /usr/local/bin/kition-kits-mcp
COPY bundles/ /opt/kition/kits/
COPY --chmod=0555 entrypoint.sh /usr/local/bin/kition-entrypoint
ENV TMPDIR=/run/kition \
    HOME=/run/kition \
    XDG_RUNTIME_DIR=/run/kition \
    XDG_CACHE_HOME=/run/kition
USER 10001:10001
WORKDIR /workspace
VOLUME ["/workspace"]
ENTRYPOINT ["/usr/local/bin/kition-entrypoint"]
