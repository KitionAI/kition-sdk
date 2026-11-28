//! Stage S of "slide usable by hand": a command may run from several keys. The menus show
//! `shortcut`; `more_shortcuts` reach the editor's frame as `moreShortcuts`, and a command without
//! any says nothing of them.

use kition_kit::{KitCommand, commands_json};

#[test]
fn a_command_carries_its_more_shortcuts_and_one_without_says_nothing() {
    let redo = KitCommand {
        id: "edit.redo".into(),
        title: "Redo".into(),
        shortcut: Some("Cmd+Y".into()),
        more_shortcuts: vec!["Cmd+Shift+Z".into()],
        ..Default::default()
    };
    let undo = KitCommand { id: "edit.undo".into(), title: "Undo".into(), shortcut: Some("Cmd+Z".into()), ..Default::default() };
    let json: serde_json::Value = serde_json::from_str(&commands_json(&[redo, undo])).unwrap();
    assert_eq!(json[0]["shortcut"], "Cmd+Y");
    assert_eq!(json[0]["moreShortcuts"], serde_json::json!(["Cmd+Shift+Z"]));
    assert!(json[1].get("moreShortcuts").is_none());
}
