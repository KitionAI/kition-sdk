//! `/api/v1/kits/grants` (Kition platform KitFiles 1.1): sessions, the choices offered for the
//! person to pick, handles, reads, staged writes, and releases, and the refusals: rights a handle
//! lacks, expired and foreign handles and choices, files that exist, entries outside the
//! workspace or hidden (never offered), and requests not addressed to a loopback host or without
//! the token. No kit executable is needed. (Ported from Kition's `kition-kits-http` tests onto
//! the choices: regressions/issue-grant-caller-path.)

mod support;

use std::time::Duration;

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use kition_kit_host::files::{Flow, GrantLimits, GrantRequest, Kind, Right, SessionRequest};
use kition_kits::KitManager;
use serde_json::{Value, json};
use support::{Answer, api, call, put, send, send_as_is, write};

struct Fixture {
    app: Router,
    kits: KitManager,
    dir: tempfile::TempDir,
    outside: tempfile::TempDir,
}

impl Fixture {
    fn root(&self) -> std::path::PathBuf {
        std::fs::canonicalize(self.dir.path()).unwrap()
    }
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(&root.join("art/note.mockdoc"), b"the document");
    write(&root.join("art/photo.png"), b"0123456789");
    write(&root.join("art/notes.txt"), b"plain");
    write(&root.join("art/out.png"), b"taken");
    write(&root.join("art/.secret.png"), b"hidden");
    write(&root.join(".kition/state.png"), b"store");
    write(&root.join("batch/one.png"), b"one");
    write(&root.join("batch/two.png"), b"two");
    write(&root.join("batch/skip.txt"), b"skip");
    write(&root.join("batch/.hidden.png"), b"hidden");
    write(&outside.path().join("private.png"), b"outside");
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link = |target: &std::path::Path, at: &str| symlink(target, root.join(at)).unwrap();
        link(&outside.path().join("private.png"), "art/escape.png");
        link(outside.path(), "away");
        link(&root.join(".kition/state.png"), "art/store.png");
        link(&outside.path().join("private.png"), "batch/three.png");
    }
    let kits = KitManager::new(Some(root.to_path_buf()), Vec::new());
    let app = support::app(&kits);
    Fixture { app, kits, dir, outside }
}

fn manifest() -> Value {
    json!({ "read": ["png", "mockdoc"], "create": ["png"], "folders": true })
}

async fn open_session(app: &Router, extra: Value) -> String {
    let mut body = json!({ "kit": "kit.mock", "document": "art/note.mockdoc", "files": manifest() });
    if let (Some(body), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
        body.extend(extra.clone());
    }
    let answer = call(app, "POST", &api("/kits/grants/sessions"), Some(body)).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.json);
    answer.data()["session"].as_str().unwrap().to_owned()
}

/// The choices of a folder: the workspace's top one, or the folder choice `folder`.
async fn choices(app: &Router, session: &str, folder: Option<&str>) -> Answer {
    call(app, "POST", &api("/kits/grants/choices"), Some(json!({ "session": session, "folder": folder }))).await
}

/// The choice the person would pick for the workspace path `path` by browsing from the top: each
/// folder of it in turn, then the entry; `None` when it is not offered. With `new`, the last
/// segment is a new file's name and the answer is the folder's choice.
async fn choice_of(app: &Router, session: &str, path: &str, kind: &str, new: bool) -> Option<String> {
    let mut segments: Vec<&str> = path.split('/').collect();
    let last = segments.pop()?;
    let mut listing = choices(app, session, None).await;
    for segment in segments {
        let folder =
            listing.data()["choices"].as_array()?.iter().find(|entry| entry["name"] == segment && entry["kind"] == "folder")?["choice"].as_str()?.to_owned();
        listing = choices(app, session, Some(&folder)).await;
    }
    if new {
        return listing.data()["folder"].as_str().map(str::to_owned);
    }
    Some(listing.data()["choices"].as_array()?.iter().find(|entry| entry["name"] == last && entry["kind"] == kind)?["choice"].as_str()?.to_owned())
}

/// The person picks `path` for the session's kit: `None` when it is not offered.
async fn grant(app: &Router, session: &str, path: &str, kind: &str, rights: Value) -> Option<Answer> {
    let choice = choice_of(app, session, path, kind, false).await?;
    Some(call(app, "POST", &api("/kits/grants"), Some(json!({ "session": session, "choice": choice, "rights": rights, "flow": "pick" }))).await)
}

/// The person names the new file `path` (a save-as): `None` when its folder is not offered.
async fn grant_new(app: &Router, session: &str, path: &str) -> Option<Answer> {
    let folder = choice_of(app, session, path, "file", true).await?;
    let name = path.rsplit('/').next()?;
    Some(
        call(app, "POST", &api("/kits/grants"), Some(json!({ "session": session, "choice": folder, "name": name, "rights": ["create"], "flow": "pick" })))
            .await,
    )
}

fn handle_of(answer: &Answer) -> String {
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.json);
    answer.data()["handle"].as_str().unwrap().to_owned()
}

fn granted(answer: Option<Answer>) -> Answer {
    answer.unwrap_or_else(|| panic!("not offered"))
}

/// Every answer names files by display name only: no workspace path, no absolute path.
fn assert_no_paths(fixture: &Fixture, answer: &Answer) {
    let text = answer.json.to_string();
    let root = fixture.root().to_string_lossy().into_owned();
    assert!(!text.contains(&root), "a path leaked: {text}");
    assert!(!text.contains("art/"), "a workspace path leaked: {text}");
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| if byte.is_ascii_alphanumeric() || b"-_.".contains(&byte) { char::from(byte).to_string() } else { format!("%{byte:02X}") })
        .collect()
}

#[tokio::test]
async fn grants_read_list_create_and_write_files() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;

    // What the person may pick: visible folders, and the files the kit's manifest takes.
    let top = choices(app, &session, None).await;
    assert_no_paths(&fixture, &top);
    let names = |listing: &Answer| -> Vec<String> {
        listing.data()["choices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| format!("{} {}", entry["kind"].as_str().unwrap(), entry["name"].as_str().unwrap()))
            .collect()
    };
    assert_eq!(names(&top), ["folder art", "folder batch"], "no hidden folder, no link out of the workspace");
    let art = top.data()["choices"][0]["choice"].as_str().unwrap().to_owned();
    assert!(art.starts_with("ch_") && art.len() == 3 + 32, "{art}");
    let listed = choices(app, &session, Some(&art)).await;
    assert_eq!(names(&listed), ["file note.mockdoc", "file out.png", "file photo.png"], "no .txt, no hidden file, no link out or into the store");

    // A picked file: stat and ranged reads.
    let picked = granted(grant(app, &session, "art/photo.png", "file", json!(["read"])).await);
    assert_no_paths(&fixture, &picked);
    assert_eq!(picked.data()["name"], "photo.png");
    assert_eq!(picked.data()["size"], 10);
    let photo = handle_of(&picked);
    let stat = call(app, "GET", &api(&format!("/kits/grants/{photo}?session={session}")), None).await;
    let read = call(app, "GET", &api(&format!("/kits/grants/{photo}/content?session={session}&offset=2&length=5")), None).await;
    assert_eq!(read.status, StatusCode::OK);
    assert_eq!(read.bytes, b"23456");
    assert_eq!(read.headers["kition-file-size"], "10");
    assert_eq!(read.headers["x-content-type-options"], "nosniff");
    assert_eq!(read.headers["etag"], stat.data()["version"].as_str().unwrap_or_default());

    // A picked folder lists the visible files it accepts, links out of the workspace skipped.
    let folder = handle_of(&granted(grant(app, &session, "batch", "folder", json!(["read", "create"])).await));
    let listed = call(app, "GET", &api(&format!("/kits/grants/{folder}/list?session={session}")), None).await;
    assert_no_paths(&fixture, &listed);
    let names: Vec<&str> = listed.data()["files"].as_array().unwrap().iter().filter_map(|file| file["name"].as_str()).collect();
    assert_eq!(names, ["one.png", "two.png"]);

    // files/create beside the document picks an unused name, and the file appears on commit.
    let created = call(app, "POST", &api("/kits/grants/create"), Some(json!({ "session": session, "suggestedName": "../out.png", "mime": "image/png" }))).await;
    assert_eq!(created.data()["name"], "out 2.png");
    assert_eq!(created.data()["version"], Value::Null);
    let out = handle_of(&created);
    let new_file = fixture.root().join("art/out 2.png");
    let chunk = put(app, &api(&format!("/kits/grants/{out}/content?session={session}&offset=0")), "hello ").await;
    assert_eq!(chunk.status, StatusCode::OK, "{}", chunk.json);
    assert!(!new_file.exists(), "a staged write is not visible");
    let last = put(app, &api(&format!("/kits/grants/{out}/content?session={session}&offset=6&final=true")), "world").await;
    assert_eq!(last.status, StatusCode::OK, "{}", last.json);
    assert!(last.data()["version"].is_string());
    assert_eq!(std::fs::read_to_string(&new_file).unwrap_or_default(), "hello world");

    // files/create in the granted folder.
    let into = call(app, "POST", &api("/kits/grants/create"), Some(json!({ "session": session, "suggestedName": "one.png", "folder": folder }))).await;
    assert_eq!(into.data()["name"], "one 2.png");

    // A picked file to replace: write with the version read.
    let target = handle_of(&granted(grant(app, &session, "art/out.png", "file", json!(["read", "write"])).await));
    let version =
        call(app, "GET", &api(&format!("/kits/grants/{target}?session={session}")), None).await.data()["version"].as_str().unwrap_or_default().to_owned();
    let replaced =
        put(app, &api(&format!("/kits/grants/{target}/content?session={session}&offset=0&final=true&expected={}", urlencode(&version))), "replaced").await;
    assert_eq!(replaced.status, StatusCode::OK, "{}", replaced.json);
    assert_eq!(std::fs::read_to_string(fixture.root().join("art/out.png")).unwrap_or_default(), "replaced");

    // The session shows its grants and logs every grant and commit (FA16, section 7).
    let view = call(app, "GET", &api(&format!("/kits/grants/sessions/{session}")), None).await;
    for part in ["grants", "log"] {
        let only = Answer { json: view.data()[part].clone(), ..call(app, "GET", &api(&format!("/kits/grants/sessions/{session}")), None).await };
        assert_no_paths(&fixture, &only);
    }
    assert_eq!(view.data()["document"], "art/note.mockdoc");
    let events: Vec<&str> = view.data()["log"].as_array().unwrap().iter().filter_map(|entry| entry["event"].as_str()).collect();
    assert_eq!(events.iter().filter(|event| **event == "commit").count(), 2);
    assert!(events.iter().filter(|event| **event == "grant").count() >= 6);

    // Released and ended: every handle and every choice stops working.
    let released =
        call(app, "POST", &api("/kits/grants/release"), Some(json!({ "session": session, "handles": [photo, "fh_00000000000000000000000000000000"] }))).await;
    assert_eq!(released.status, StatusCode::OK);
    let gone = call(app, "GET", &api(&format!("/kits/grants/{photo}?session={session}")), None).await;
    assert_eq!(gone.status, StatusCode::FORBIDDEN);
    assert_eq!(gone.reason(), "file-not-granted");
    let ended = call(app, "DELETE", &api(&format!("/kits/grants/sessions/{session}")), None).await;
    assert!(ended.data()["revoked"].as_array().is_some_and(|handles| handles.len() >= 5));
    let after = call(app, "GET", &api(&format!("/kits/grants/{folder}/list?session={session}")), None).await;
    assert_eq!(after.reason(), "file-not-granted");
    let stale = call(app, "POST", &api("/kits/grants"), Some(json!({ "session": session, "choice": art, "rights": ["read"], "flow": "pick" }))).await;
    assert_eq!(stale.reason(), "file-not-granted");
}

/// regressions/issue-grant-caller-path: `POST /kits/grants` took the path of the file the person
/// picked from its caller, so whoever could call it granted a kit any file it named. A grant now
/// names a choice the server offered to that session; a path, a made-up choice and another
/// session's choice grant nothing.
#[tokio::test]
async fn a_grant_takes_no_path_from_its_caller() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    let other = open_session(app, json!({})).await;
    for body in [
        json!({ "session": session, "path": "art/photo.png", "kind": "file", "rights": ["read"], "flow": "pick" }),
        json!({ "session": session, "path": "art/photo.png", "choice": "art/photo.png", "kind": "file", "rights": ["read"], "flow": "drop" }),
    ] {
        let answer = call(app, "POST", &api("/kits/grants"), Some(body)).await;
        assert!(answer.status == StatusCode::BAD_REQUEST || answer.reason() == "file-not-granted", "{}", answer.json);
    }
    let made_up = call(
        app,
        "POST",
        &api("/kits/grants"),
        Some(json!({ "session": session, "choice": "ch_00000000000000000000000000000000", "rights": ["read"], "flow": "pick" })),
    )
    .await;
    assert_eq!((made_up.status, made_up.reason()), (StatusCode::FORBIDDEN, &json!("file-not-granted")));
    let theirs = choice_of(app, &other, "art/photo.png", "file", false).await.unwrap();
    let foreign = call(app, "POST", &api("/kits/grants"), Some(json!({ "session": session, "choice": theirs, "rights": ["read"], "flow": "pick" }))).await;
    assert_eq!((foreign.status, foreign.reason()), (StatusCode::FORBIDDEN, &json!("file-not-granted")));
    // A choice is no folder to browse unless it is one, and only the session's own browse.
    let photo = choice_of(app, &session, "art/photo.png", "file", false).await.unwrap();
    assert_eq!(choices(app, &session, Some(&photo)).await.status, StatusCode::BAD_REQUEST);
    let art = choice_of(app, &session, "art/x", "file", true).await.unwrap();
    assert_eq!(choices(app, &other, Some(&art)).await.reason(), "file-not-granted");
    // A new file's name is one plain, visible name in the folder chosen.
    for (name, reason) in
        [("../escape.png", Value::Null), ("sub/new.png", Value::Null), ("..", Value::Null), ("", Value::Null), (".hidden.png", json!("not-allowed"))]
    {
        let answer =
            call(app, "POST", &api("/kits/grants"), Some(json!({ "session": session, "choice": art, "name": name, "rights": ["create"], "flow": "pick" })))
                .await;
        assert!(answer.status.is_client_error(), "{name}: {}", answer.json);
        assert_eq!(answer.reason(), &reason, "{name}");
    }
    let view = call(app, "GET", &api(&format!("/kits/grants/sessions/{session}")), None).await;
    assert_eq!(view.data()["grants"], json!([]), "nothing was granted");
    // Choices expire with their session.
    fixture.kits.grants().set_limits(GrantLimits { idle: Duration::from_millis(50), ..GrantLimits::default() });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let expired = call(app, "POST", &api("/kits/grants"), Some(json!({ "session": session, "choice": photo, "rights": ["read"], "flow": "pick" }))).await;
    assert_eq!(expired.reason(), "file-not-granted");
}

#[tokio::test]
async fn refuses_rights_a_handle_lacks() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    let other = open_session(app, json!({})).await;
    let photo = handle_of(&granted(grant(app, &session, "art/photo.png", "file", json!(["read"])).await));
    // A read handle writes nothing.
    let write = put(app, &api(&format!("/kits/grants/{photo}/content?session={session}&offset=0&final=true&expected=x")), "x").await;
    assert_eq!(write.status, StatusCode::FORBIDDEN);
    assert_eq!(write.reason(), "file-not-granted");
    // A file handle lists nothing.
    let list = call(app, "GET", &api(&format!("/kits/grants/{photo}/list?session={session}")), None).await;
    assert_eq!(list.reason(), "file-not-granted");
    // Another session's handle is foreign (FA5).
    let foreign = call(app, "GET", &api(&format!("/kits/grants/{photo}/content?session={other}")), None).await;
    assert_eq!(foreign.status, StatusCode::FORBIDDEN);
    assert_eq!(foreign.reason(), "file-not-granted");
    // A create handle reads nothing.
    let created = handle_of(&call(app, "POST", &api("/kits/grants/create"), Some(json!({ "session": session, "suggestedName": "new.png" }))).await);
    let read = call(app, "GET", &api(&format!("/kits/grants/{created}/content?session={session}")), None).await;
    assert_eq!(read.reason(), "file-not-granted");
    // A file handle is no folder to create in.
    let into = call(app, "POST", &api("/kits/grants/create"), Some(json!({ "session": session, "suggestedName": "a.png", "folder": photo }))).await;
    assert_eq!(into.reason(), "file-not-granted");
    // The manifest bounds what a kit may ask for (K15): a type it does not take is not offered.
    assert!(grant(app, &session, "art/notes.txt", "file", json!(["read"])).await.is_none());
    let export = call(app, "POST", &api("/kits/grants/create"), Some(json!({ "session": session, "suggestedName": "a.txt" }))).await;
    assert_eq!(export.reason(), "not-allowed");
    let no_folders = open_session(app, json!({ "files": { "read": ["png"] } })).await;
    let folder = granted(grant(app, &no_folders, "batch", "folder", json!(["read"])).await);
    assert_eq!(folder.reason(), "not-allowed");
    let nothing = open_session(app, json!({ "files": {} })).await;
    assert!(grant(app, &nothing, "art/photo.png", "file", json!(["read"])).await.is_none());
    // A read-only session replaces no file (FA17), but still creates.
    let read_only = open_session(app, json!({ "readOnly": true })).await;
    let replace = granted(grant(app, &read_only, "art/out.png", "file", json!(["write"])).await);
    assert_eq!(replace.reason(), "not-allowed");
    let export = call(app, "POST", &api("/kits/grants/create"), Some(json!({ "session": read_only, "suggestedName": "copy.png" }))).await;
    assert_eq!(export.status, StatusCode::OK);
    // An agent replaces a file only through a draft or the person's approval (FA13).
    let grants = fixture.kits.grants();
    let principal = kition_kits_http::PERSON;
    let agent = grants
        .open_session(SessionRequest {
            kit: "kit.mock",
            principal,
            document: None,
            manifest: serde_json::from_value(manifest()).unwrap_or_default(),
            read_only: false,
        })
        .unwrap();
    let request = |approved| GrantRequest { path: "art/out.png", kind: Kind::File, rights: &[Right::Write], accept: &[], flow: Flow::Agent, approved };
    let unapproved = grants.grant(&agent, principal, request(false));
    assert!(matches!(unapproved, Err(ref error) if error.reason() == Some("not-allowed")), "{unapproved:?}");
    assert!(grants.grant(&agent, principal, request(true)).is_ok());
    // Another person holds none of it.
    let stranger = grants.view(&agent, "person:other");
    assert!(matches!(stranger, Err(ref error) if error.reason() == Some("file-not-granted")));
}

#[tokio::test]
async fn handles_expire_with_their_session() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    let photo = handle_of(&granted(grant(app, &session, "art/photo.png", "file", json!(["read"])).await));
    let created = handle_of(&call(app, "POST", &api("/kits/grants/create"), Some(json!({ "session": session, "suggestedName": "late.png" }))).await);
    let staged = put(app, &api(&format!("/kits/grants/{created}/content?session={session}&offset=0")), "part").await;
    assert_eq!(staged.status, StatusCode::OK);
    // Nobody uses the session now; a short idle limit, set after the setup so a slow machine
    // cannot expire it early, ends it.
    fixture.kits.grants().set_limits(GrantLimits { idle: Duration::from_millis(50), ..GrantLimits::default() });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let expired = call(app, "GET", &api(&format!("/kits/grants/{photo}/content?session={session}")), None).await;
    assert_eq!(expired.status, StatusCode::FORBIDDEN);
    assert_eq!(expired.reason(), "file-not-granted");
    let finish = put(app, &api(&format!("/kits/grants/{created}/content?session={session}&offset=4&final=true")), "!").await;
    assert_eq!(finish.reason(), "file-not-granted");
    // The expired write left nothing behind: no file, no staging file.
    let leftovers: Vec<String> = std::fs::read_dir(fixture.root().join("art"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("late"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let unknown = call(app, "GET", &api("/kits/grants/sessions/fs_00000000000000000000000000000000"), None).await;
    assert_eq!(unknown.reason(), "file-not-granted");
}

#[tokio::test]
async fn never_replaces_an_existing_file_without_its_version() {
    let fixture = fixture();
    let app = &fixture.app;
    let root = fixture.root();
    let session = open_session(app, json!({})).await;
    // A create grant on a file that exists is refused (H5): picked as a file, or named anew.
    let taken = granted(grant(app, &session, "art/out.png", "file", json!(["create"])).await);
    assert_eq!(taken.status, StatusCode::CONFLICT);
    assert_eq!(taken.reason(), "conflict");
    let named = granted(grant_new(app, &session, "art/out.png").await);
    assert_eq!(named.reason(), "conflict");
    // A new name the person picked, taken before the commit: conflict, and the file stays.
    let picked = handle_of(&granted(grant_new(app, &session, "art/picked.png").await));
    write(&root.join("art/picked.png"), b"someone else");
    let commit = put(app, &api(&format!("/kits/grants/{picked}/content?session={session}&offset=0&final=true")), "mine").await;
    assert_eq!(commit.reason(), "conflict");
    assert_eq!(std::fs::read_to_string(root.join("art/picked.png")).unwrap_or_default(), "someone else");
    // A files/create name taken before the commit moves on to the next unused name.
    let created = handle_of(&call(app, "POST", &api("/kits/grants/create"), Some(json!({ "session": session, "suggestedName": "race.png" }))).await);
    write(&root.join("art/race.png"), b"first");
    let moved = put(app, &api(&format!("/kits/grants/{created}/content?session={session}&offset=0&final=true")), "second").await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.json);
    assert_eq!(std::fs::read_to_string(root.join("art/race.png")).unwrap_or_default(), "first");
    assert_eq!(std::fs::read_to_string(root.join("art/race 2.png")).unwrap_or_default(), "second");
    let stat = call(app, "GET", &api(&format!("/kits/grants/{created}?session={session}")), None).await;
    assert_eq!(stat.data()["name"], "race 2.png");
    // A create handle commits once.
    let again = put(app, &api(&format!("/kits/grants/{created}/content?session={session}&offset=0&final=true")), "third").await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(again.reason(), "already-committed");
    // A write handle needs the version it replaces, and a stale one is a conflict.
    let target = handle_of(&granted(grant(app, &session, "art/out.png", "file", json!(["write"])).await));
    let bare = put(app, &api(&format!("/kits/grants/{target}/content?session={session}&offset=0&final=true")), "x").await;
    assert_eq!(bare.reason(), "conflict");
    let stale = put(app, &api(&format!("/kits/grants/{target}/content?session={session}&offset=0&final=true&expected=%22stale%22")), "x").await;
    assert_eq!(stale.reason(), "conflict");
    assert_eq!(std::fs::read_to_string(root.join("art/out.png")).unwrap_or_default(), "taken");
    // Chunks come in order.
    let out_of_order = put(app, &api(&format!("/kits/grants/{target}/content?session={session}&offset=5")), "x").await;
    assert_eq!(out_of_order.status, StatusCode::BAD_REQUEST);
    assert_eq!(*out_of_order.reason(), Value::Null);
}

/// sdk.gateway.security/workspace-paths: nothing outside the workspace, hidden, or behind a link
/// out of it is offered, whether it exists or not; a session's document is confined; and a file
/// that becomes a link out after its grant is no longer read.
#[tokio::test]
async fn offers_nothing_outside_the_workspace() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    let mut refused = vec![
        "../outside.png",
        "art/../../outside.png",
        "/etc/hosts",
        "art\\photo.png",
        ".kition/state.png",
        ".kition/missing.png",
        "art/.secret.png",
        "art/.missing.png",
        "missing/photo.png",
        "art/missing.png",
    ];
    if cfg!(unix) {
        // Links out of the workspace, and into its hidden store.
        refused.extend(["art/escape.png", "away/private.png", "art/store.png"]);
    }
    for path in refused {
        assert!(grant(app, &session, path, "file", json!(["read"])).await.is_none(), "{path} is offered");
    }
    for path in ["../new.png", ".kition/new.png", "away/new.png"] {
        assert!(grant_new(app, &session, path).await.is_none(), "{path} is offered");
    }
    let hidden = granted(grant_new(app, &session, "art/.new.png").await);
    assert_eq!(hidden.reason(), "not-allowed");
    if cfg!(unix) {
        assert!(grant(app, &session, "away", "folder", json!(["read"])).await.is_none());
    }
    // A session's document is confined too.
    for document in ["../note.mockdoc", "/etc/hosts", ".kition/state.png"] {
        let outside = call(app, "POST", &api("/kits/grants/sessions"), Some(json!({ "kit": "kit.mock", "document": document, "files": manifest() }))).await;
        assert_eq!(outside.reason(), "not-allowed", "{document}");
    }
    // A file granted inside that later becomes a link out of the workspace is no longer read.
    #[cfg(unix)]
    {
        let root = fixture.root();
        write(&root.join("art/notes.png"), b"inside");
        let photo = handle_of(&granted(grant(app, &session, "art/notes.png", "file", json!(["read"])).await));
        std::fs::remove_file(root.join("art/notes.png")).unwrap();
        std::os::unix::fs::symlink(fixture.outside.path().join("private.png"), root.join("art/notes.png")).unwrap();
        let read = call(app, "GET", &api(&format!("/kits/grants/{photo}/content?session={session}")), None).await;
        assert_eq!(read.reason(), "not-allowed");
        assert!(read.bytes.len() < 200, "no file bytes in a refusal");
    }
}

#[tokio::test]
async fn refuses_requests_not_addressed_to_a_loopback_host() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    let choice = choice_of(app, &session, "art/photo.png", "file", false).await.unwrap();
    for host in ["evil.example", "evil.example:34115", "192.168.1.20:34115"] {
        let request = Request::builder()
            .method("POST")
            .uri(api("/kits/grants"))
            .header("host", host)
            .header("content-type", "application/json")
            .body(Body::from(json!({ "session": session, "choice": choice, "rights": ["read"], "flow": "pick" }).to_string()))
            .unwrap();
        let answer = send(app, request).await;
        assert_eq!(answer.status, StatusCode::FORBIDDEN, "{host}");
        assert!(answer.json.is_null(), "no grant for {host}: {}", answer.json);
    }
    let view = call(app, "GET", &api(&format!("/kits/grants/sessions/{session}")), None).await;
    assert_eq!(view.data()["grants"], json!([]));
}

#[tokio::test]
async fn refuses_every_grant_route_without_the_api_token() {
    let fixture = fixture();
    let app = &fixture.app;
    let session = open_session(app, json!({})).await;
    let handle = handle_of(&granted(grant(app, &session, "art/photo.png", "file", json!(["read", "write"])).await));
    let choice = choice_of(app, &session, "art/out.png", "file", false).await.unwrap();
    let attempts = [
        ("POST", api("/kits/grants/sessions"), json!({ "kit": "kit.mock" }).to_string()),
        ("POST", api("/kits/grants/choices"), json!({ "session": session }).to_string()),
        ("POST", api("/kits/grants"), json!({ "session": session, "choice": choice, "rights": ["read"], "flow": "pick" }).to_string()),
        ("POST", api("/kits/grants/create"), json!({ "session": session, "suggestedName": "a.png" }).to_string()),
        ("POST", api("/kits/grants/release"), json!({ "session": session, "handles": [handle] }).to_string()),
        ("GET", api(&format!("/kits/grants/{handle}?session={session}")), String::new()),
        ("GET", api(&format!("/kits/grants/{handle}/list?session={session}")), String::new()),
        ("GET", api(&format!("/kits/grants/{handle}/content?session={session}")), String::new()),
        ("PUT", api(&format!("/kits/grants/{handle}/content?session={session}&offset=0")), "x".to_owned()),
        ("GET", api(&format!("/kits/grants/sessions/{session}")), String::new()),
        ("DELETE", api(&format!("/kits/grants/sessions/{session}")), String::new()),
    ];
    for (method, uri, body) in attempts {
        for token in [None, Some("wrong")] {
            let mut request = Request::builder().method(method).uri(&uri).header("content-type", "application/json");
            if let Some(token) = token {
                request = request.header(kition_http_guard::TOKEN_HEADER, token);
            }
            let answer = send_as_is(app, request.body(Body::from(body.clone())).unwrap()).await;
            assert_eq!(answer.status, StatusCode::UNAUTHORIZED, "{method} {uri}");
            assert_eq!(answer.reason(), "api_token", "{method} {uri}");
        }
    }
    // Nothing changed: the session is open with its one grant, and the file is as it was.
    let view = call(app, "GET", &api(&format!("/kits/grants/sessions/{session}")), None).await;
    assert_eq!(view.status, StatusCode::OK);
    assert_eq!(view.data()["grants"].as_array().map(Vec::len), Some(1));
    assert_eq!(std::fs::read_to_string(fixture.root().join("art/photo.png")).unwrap_or_default(), "0123456789");
}
