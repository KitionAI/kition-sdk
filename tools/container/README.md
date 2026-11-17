# All kits over MCP in one container

This image runs `kition-kits-mcp` over **stdio**, with one persistent workspace
mount. It serves the 16 kits in `tools/kit-naming.mjs`, rather than the smaller
kit selection in `sdk.json`. The binary has no HTTP listener mode: its CLI
ends in `mcp::serve_stdio`. Kition's application HTTP endpoint is a separate
service and is not provided by this image. No port is exposed.

From the SDK repository root, after the owner has built each sibling kit's
headless executable for the chosen Linux target:

```sh
node tools/container/assemble-context.mjs --repos .. --target x86_64-unknown-linux-gnu --out target/container-amd64
docker build --platform linux/amd64 -t kition-kits-mcp:local target/container-amd64
```

For ARM64, use `--target aarch64-unknown-linux-gnu`, an unused output folder,
and `docker build --platform linux/arm64`. The script copies outputs only;
it never builds or launches a kit. All 16 outputs are required. They must be
GNU/Linux binaries for that architecture, built against glibc no newer than
Debian bookworm's 2.36. A macOS host's native `target/release` outputs do not
work. The script checks the ELF header and execute bits, but cannot certify
ABI compatibility, protocol compatibility or manifest version lockstep.

The required source layout is:

```text
<repos>/kition-<kit>/kit.json
<repos>/kition-<kit>/target/<rust-target>/release/kition-<kit>
```

`<kit>` is board, cad, design, doc, film, html, layout, motion, note, pdf,
photo, scene, sheet, slide, table or vector. Use the manifest from the same revision
as its executable. For kits needing external runtime files, stage them under
`<assets>/<kit>/` and add `--assets <assets>` to the assembly command. Paths
are preserved beside the executable; assets cannot replace `kit.json` or
`kition-<kit>`, and symlinks are rejected. Package libraries must have a
working loader search path (for example an `$ORIGIN` rpath); the image does
not guess paths or install kit-specific libraries, fonts or media programs.

The generated Docker build context is:

```text
Dockerfile
entrypoint.sh
sdk/
  Cargo.toml
  Cargo.lock
  crates/...
  examples/grid-kit/...
  examples/grid-kit-headless/...
bundles/
  <kit>/kit.json
  <kit>/kition-<kit>
  <kit>/<optional runtime assets>...
```

The source snapshot copies current SDK files, including uncommitted source;
assemble only after concurrent work has settled. It excludes `.git`, `target`
and `node_modules` directories. Use a new output directory each time; an
existing output is refused. The build stage compiles only `kition-kits-mcp`
with the SDK lock file. Building may download crates and image packages;
the runtime needs no network. The runtime is Debian slim with glibc,
libgcc and libstdc++, no compiler, and UID/GID 10001.

Run from a directory containing a writable `workspace/` directory:

```sh
docker run --rm -i --init --network none --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /run/kition:rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001 --mount "type=bind,src=$(pwd)/workspace,dst=/workspace" kition-kits-mcp:local
```

Keep stdin open (`-i`) and do not allocate a TTY. The workspace must be
readable and writable by container UID/GID 10001; provision ownership or an
ACL on Linux. The image declares `/workspace` as its only volume. The
separate private **tmpfs** at `/run/kition` is ephemeral memory, not a second
persistent volume. `TMPDIR`, `HOME` and the XDG runtime/cache variables point
there. The host puts each kit process's private runtime below `TMPDIR`,
outside the workspace; nothing should need a writable image root. Size the
tmpfs for your documents; its contents disappear when the container exits.

Append `--unified` to expose `kit_<action>` tools routed by extension.
Append `--drafts` to default edits to drafts (calls can still request
`draft: false`). With no flags, tools use each kit's prefix and edits are
live. Drafts persist in `/workspace/.kition/drafts/`. The entrypoint passes
other CLI options through, including repeatable `--kit`, and handles the
person's `drafts list`, `drafts compare <path>`, `drafts merge <path>` and
`drafts discard <path>` commands with the same mounts. For example, append
`drafts list` after the image name in the command above. See
[conformance](../../docs/platform/conformance.md) for the native CLI and checks.

The container isolation flags above require no kit `--sandbox` flag. That
separate, evolving feature requires Linux Landlock/seccomp support and may
interact with Docker's seccomp policy; it is not enabled here.

A stdio MCP client's configuration (`mcpServers` convention) can use:

```json
{
  "mcpServers": {
    "kition-kits": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i", "--init", "--network", "none", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/run/kition:rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001",
        "--mount", "type=bind,src=./workspace,dst=/workspace",
        "kition-kits-mcp:local", "--unified", "--drafts"
      ]
    }
  }
}
```

Replace `src=./workspace` with your workspace's full path in your local
configuration; clients differ in working directory and configuration schema.
No host environment or credentials need forwarding into the container.

Validate assembled images with the selected kit executables and runtime assets.
Discovery alone does not verify rendering, export or offline operation.
The Docker build uses `--locked` and requires a current Cargo lockfile.
