//! `kit-grid`: the reference grid kit for Kition's agent, served by `kition-headless` as its
//! `kit.json` declares it.

fn main() -> std::process::ExitCode {
    kition_headless::run_manifest::<grid_kit::GridDocument>(include_str!("../../grid-kit/kit.json"), &[], &[])
}
