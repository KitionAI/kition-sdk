mod common;

use std::path::Path;
use std::process::Command;

fn check_layout(layout: &str, nearest: bool) {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("target/debug");
    let directory = profile.join(layout);
    std::fs::create_dir_all(&directory).unwrap();
    let name = format!("kition-kit-mock{}", std::env::consts::EXE_SUFFIX);
    let mock = profile.join(&name);
    std::fs::write(&mock, "workspace binary").unwrap();
    let expected = if nearest {
        let path = directory.join(&name);
        std::fs::write(&path, "nearest binary").unwrap();
        path
    } else {
        // A directory with the right name must not hide the workspace executable.
        std::fs::create_dir(directory.join(&name)).unwrap();
        mock
    };
    let executable = directory.join(format!("binary-layout-test{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    let output = run_copy(Command::new(executable).args(["--exact", "lookup_child", "--nocapture"]).env("KITION_TEST_BINARY_EXPECTED", expected));
    assert!(output.status.success(), "{layout}: {}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}

#[test]
fn finds_mock_from_deps() {
    check_layout("deps", false);
}

#[test]
fn finds_mock_from_build_output() {
    check_layout("build/kition-env/b2855dbc1dbeaca7/out", false);
}

#[test]
fn chooses_the_first_binary_in_the_ancestors() {
    check_layout("build/kition-env/b2855dbc1dbeaca7/out", true);
}

/// Runs a freshly copied test executable. On Linux another test thread may fork while the copy's
/// write handle is still open, and the child inherits it until it execs: spawning then fails with
/// "text file busy" for a moment, so try again briefly.
fn run_copy(command: &mut Command) -> std::process::Output {
    for _ in 0..50 {
        match command.output() {
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => std::thread::sleep(std::time::Duration::from_millis(20)),
            result => return result.unwrap(),
        }
    }
    command.output().unwrap()
}

fn missing_binary(ci: bool) -> std::process::Output {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "lookup_missing_child", "--nocapture"]).env("KITION_TEST_MISSING_BINARY", "1");
    if ci {
        command.env("CI", "true");
    } else {
        command.env_remove("CI");
    }
    command.output().unwrap()
}

#[test]
fn missing_binary_fails_in_ci() {
    let output = missing_binary(true);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("build kition-ci-layout-missing first"));
}

#[test]
fn missing_binary_can_skip_locally() {
    let output = missing_binary(false);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn lookup_missing_child() {
    if std::env::var_os("KITION_TEST_MISSING_BINARY").is_some() {
        assert!(common::workspace_binary("kition-ci-layout-missing").is_none());
    }
}

#[test]
fn lookup_child() {
    let Some(expected) = std::env::var_os("KITION_TEST_BINARY_EXPECTED") else {
        return;
    };
    assert_eq!(common::mock_binary().as_deref(), Some(Path::new(&expected)));
}
