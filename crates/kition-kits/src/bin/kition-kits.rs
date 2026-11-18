//! `kition-kits`: the Kits Service API for hosts in any language (`kition_kits::cli::serve`).

fn main() -> std::process::ExitCode {
    kition_kits::cli::serve::main("kition-kits", std::env::args().skip(1), None)
}
