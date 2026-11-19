//! `kition`'s usage and mistakes: each command's own `--help`, a mistyped command naming the
//! closest known one instead of printing the whole usage, a grouped top-level usage; and
//! `kition mcp` serving the folder it starts in when no `--workspace` is given, saying so.

mod support;

use support::{kition, run, workspace_binary};

#[test]
fn each_command_has_its_own_usage_and_a_mistake_names_the_closest() {
    let home = tempfile::tempdir().unwrap();
    let home = home.path();

    let (ok, out, _) = run(kition(home).arg("--help"));
    assert!(ok && out.lines().count() <= 40, "{out}");
    for group in ["kits:", "agents:", "servers:", "troubleshooting:"] {
        assert!(out.contains(group), "{group}: {out}");
    }

    for (args, starts) in [
        (&["kit", "--help"][..], "usage: kition kit <command>"),
        (&["kit"][..], "usage: kition kit <command>"),
        (&["kit", "install", "--help"][..], "usage: kition kit install"),
        (&["kit", "add", "-h"][..], "usage: kition kit add"),
        (&["kit", "pack", "--help"][..], "usage: kition kit pack"),
        (&["kit", "info", "--help"][..], "usage: kition kit info"),
        (&["agent", "--help"][..], "usage: kition agent <command>"),
        (&["agent", "add", "--help"][..], "usage: kition agent add"),
        (&["doctor", "--help"][..], "usage: kition doctor"),
    ] {
        let (ok, out, err) = run(kition(home).args(args));
        assert!(ok && out.starts_with(starts), "{args:?}: {out}{err}");
        assert!(!out.contains("troubleshooting:"), "{args:?} prints its own usage, not the whole one");
    }

    for (args, says) in [
        (&["install", "note"][..], "unknown command install; did you mean `kition kit install`?"),
        (&["kit", "instal", "note"][..], "unknown kit command instal; did you mean `kition kit install`?"),
        (&["doctr"][..], "did you mean `kition doctor`?"),
        (&["agent", "ad", "cursor"][..], "did you mean `kition agent add`?"),
    ] {
        let (ok, out, err) = run(kition(home).args(args));
        assert!(!ok && out.is_empty() && err.contains(says), "{args:?}: {err}");
        assert!(err.lines().count() <= 3 && err.contains("--help"), "a pointer to --help, not the whole usage: {err}");
    }
    let (ok, _, err) = run(kition(home).args(["kit", "list", "--frob"]));
    assert!(!ok && err.contains("unknown option --frob") && err.contains("kition kit list --help"), "{err}");
    let (ok, _, err) = run(kition(home).args(["kit", "remove"]));
    assert!(!ok && err.contains("name a kit"), "{err}");
}

#[test]
fn mcp_serves_the_folder_it_starts_in_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = std::fs::canonicalize(dir.path()).unwrap().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let missing = dir.path().join("no-index.json").display().to_string();
    let home = dir.path().join("home");

    let (ok, _, err) = run(kition(&home).args(["mcp", "--no-install", "--index", &missing]).current_dir(&workspace));
    assert!(ok, "{err}");
    assert!(err.contains(&format!("kition mcp: workspace {} (the current folder", workspace.display())), "{err}");

    let other = dir.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let (ok, _, err) = run(kition(&home).args(["mcp", "--no-install", "--index", &missing, "--workspace"]).arg(&other).current_dir(&workspace));
    assert!(ok && err.contains("(--workspace)") && err.contains("other"), "{err}");

    // kition-kits-mcp has no store, and still needs --workspace.
    if let Some(server) = workspace_binary("kition-kits-mcp") {
        let output = std::process::Command::new(server).current_dir(&workspace).stdin(std::process::Stdio::null()).output().unwrap();
        assert!(!output.status.success() && String::from_utf8_lossy(&output.stderr).contains("--workspace must name a folder"));
    }
}
