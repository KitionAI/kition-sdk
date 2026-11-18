//! `kition-kits-mcp`: the kits' stdio MCP server (`kition_kits::cli::mcp`).

fn main() -> std::process::ExitCode {
    kition_kits::cli::mcp::main("kition-kits-mcp", std::env::args().skip(1), None)
}
