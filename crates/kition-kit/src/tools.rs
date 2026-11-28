//! Engine tools (standard section 6, capability `engine-tools`): a kit whose engine owns its
//! tools' state machines (pen, direct selection, type) exposes them, and the host runs one
//! generic tool bridge instead of re-implementing each kit's tools.
//!
//! The host sends pointer, key, and text events in document pixels with the view's zoom; the
//! engine answers with what the host must do (open a dialog, switch tool, show a status), the
//! overlays to draw over the canvas (marquee, path previews, anchors, handles, labels), and the
//! cursor. The host draws overlays in its own visual style; engines never draw chrome.
//!
//! Implement [`KitTools`] next to [`crate::KitDocument`] and export both with
//! [`crate::export_kit_tools!`] after [`crate::export_kit_document!`].

use serde::{Deserialize, Serialize};

/// Modifier keys held during an event. `command` is Command on macOS and Control elsewhere.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolMods {
    pub shift: bool,
    pub alt: bool,
    pub command: bool,
    pub control: bool,
    pub space: bool,
}

/// What a pointer did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PointerAction {
    Down,
    Drag,
    Up,
    /// Moved with no button held (hover feedback, smart guides).
    Move,
    DoubleClick,
}

/// Which button a pointer event is for (KitPointer PT14).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PointerButton {
    /// The left button, a pen's tip, a finger.
    #[default]
    Primary,
    /// The right button (a context menu's click; on a Mac also Ctrl and a click). The editor sends
    /// it as a `Down` and an `Up` only to a kit that opens context menus from the canvas
    /// (`useEngineTools`' `onContextMenu`); every other kit never gets one.
    Secondary,
    Middle,
}

/// One pointer event in document pixels, with the view's zoom (screen pixels per document pixel).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPointer {
    pub action: PointerAction,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub mods: ToolMods,
    #[serde(default = "full_pressure")]
    pub pressure: f32,
    pub zoom: f64,
    /// The button, for a `Down` and its `Up`: `Primary` unless the editor says otherwise.
    #[serde(default)]
    pub button: PointerButton,
    /// A press's click count: 1, 2 for the second press of a double click, 3 for a triple click
    /// (a paragraph, a row); 1 for every other event.
    #[serde(default = "one_click")]
    pub clicks: u8,
}

fn full_pressure() -> f32 {
    1.0
}

fn one_click() -> u8 {
    1
}

/// One tool on the rail. Tools in the same `group` share a slot (the first is shown).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: String,
    pub label: String,
    /// A single-key shortcut, `V` or `Shift+M`.
    pub shortcut: Option<String>,
    /// The engine's icon name; hosts map it to their own icons.
    pub icon: String,
    pub group: usize,
}

/// A drawing primitive over the canvas, in document pixels. Colours are RGBA.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolOverlay {
    /// A rubber-band rectangle.
    Marquee {
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
    },
    /// A path preview as SVG path data.
    Path {
        d: String,
        color: [u8; 4],
        width: f32,
        dashed: bool,
    },
    /// Marching ants: `d` (SVG path data) stroked dashed in `color`, `width` screen pixels wide,
    /// its dashes moving along it (a copied area). The host animates them only while one is shown,
    /// so a canvas without them does not redraw.
    Ants {
        d: String,
        color: [u8; 4],
        width: f32,
    },
    Line {
        ax: f64,
        ay: f64,
        bx: f64,
        by: f64,
        color: [u8; 4],
        dashed: bool,
    },
    /// An anchor square; `filled` when selected. `size` is in screen pixels.
    Anchor {
        x: f64,
        y: f64,
        color: [u8; 4],
        filled: bool,
        size: f32,
    },
    /// A direction handle's end.
    Handle {
        x: f64,
        y: f64,
        color: [u8; 4],
    },
    Label {
        x: f64,
        y: f64,
        text: String,
        color: [u8; 4],
    },
    /// A measurement pill near the pointer.
    Measure {
        x: f64,
        y: f64,
        text: String,
    },
    /// A translucent quad (text selection).
    Highlight {
        quad: [[f64; 2]; 4],
        color: [u8; 4],
    },
    /// A colour chip of fixed screen size (a gradient stop).
    Swatch {
        x: f64,
        y: f64,
        color: [u8; 4],
        selected: bool,
    },
}

/// Something only the host can do.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolRequest {
    /// Open a dialog (for example a rectangle's exact size after a click).
    Dialog {
        name: String,
        params: serde_json::Value,
    },
    SwitchTool {
        id: String,
    },
    Status {
        text: String,
    },
}

/// The engine's answer to an event.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResponse {
    pub requests: Vec<ToolRequest>,
    pub overlays: Vec<ToolOverlay>,
    /// A CSS cursor name: `default`, `crosshair`, `move`, `text`, `grab`, `pointer`, `copy`,
    /// `ns-resize`, `ew-resize`, `nwse-resize`, `nesw-resize`, `not-allowed`.
    pub cursor: String,
    /// The tool is in the middle of something (a drag, an open path).
    pub busy: bool,
    /// The tool takes typed text now (Type tool editing); single-key shortcuts must be held back.
    pub wants_text: bool,
}

/// The tools of a [`crate::KitDocument`]. Errors are messages, never panics.
pub trait KitTools {
    fn tools(&self) -> Vec<ToolInfo>;
    /// The active tool's id.
    fn tool(&self) -> String;
    fn select_tool(&mut self, id: &str, zoom: f64) -> Result<ToolResponse, String>;
    fn pointer(&mut self, event: &ToolPointer) -> Result<ToolResponse, String>;
    /// A key the tool may take: `Enter`, `Escape`, `Backspace`, `Delete`, arrows, `Tab`.
    fn key(&mut self, key: &str, mods: ToolMods, zoom: f64) -> Result<ToolResponse, String>;
    /// Typed text for a tool that wants it.
    fn text(&mut self, text: &str, zoom: f64) -> Result<ToolResponse, String>;
    /// The overlays and cursor now, at `(x, y)` (for hover without an event).
    fn state(&mut self, x: f64, y: f64, mods: ToolMods, zoom: f64) -> ToolResponse;
    /// The document area (document pixels) the last event changed, when it changed only that (a
    /// caret moved in a cell, text selected in a frame), and forgets it. The page then repaints
    /// that area instead of the whole view, so it must cover every pixel the event changed. `None`
    /// (the default) repaints everything when the document changed; [`ToolDamage::NONE`] says the
    /// event changed no pixel at all though the document's state moved (a selection kept in a
    /// panel, a caret the overlays draw): nothing repaints.
    fn take_damage(&mut self) -> Option<ToolDamage> {
        None
    }

    /// Whether the tool takes the editing keys now (arrows, Home, End, Enter, Tab, Delete,
    /// Backspace) though it is neither busy nor taking text: slides with nothing selected turn
    /// with the arrows. Escape stays the editor's (leaving Focus) unless the tool is busy or takes
    /// text. Answers carry it as `takesKeys`; the default takes none.
    fn takes_keys(&self) -> bool {
        false
    }

    /// The text caret while the tool takes text, in document pixels: the editor puts its hidden
    /// text field there, so an input method's candidate window opens beside the caret. Answers
    /// carry it as `caret`; `None` (the default) leaves the field where it is.
    fn caret(&self) -> Option<ToolCaret> {
        None
    }

    /// What an input method is composing in the text the tool takes, and its cursor in it (in
    /// characters): the kit shows it at the caret, underlined, without changing the document; the
    /// empty text ends it (the composition was cancelled, or its finished text comes next through
    /// [`KitTools::text`], as one undo step). `None` (the default): the kit shows no composition,
    /// and the editor keeps its last answer.
    fn preedit(&mut self, text: &str, cursor: u32, zoom: f64) -> Option<Result<ToolResponse, String>> {
        let _ = (text, cursor, zoom);
        None
    }

    /// Keeps the active tool for one object after another (Lock Drawing Mode) until Escape or
    /// another tool, or not. The editor asks it right after [`KitTools::select_tool`], which
    /// itself drops any lock. The default keeps no lock.
    fn lock_tool(&mut self, locked: bool) {
        let _ = locked;
    }

    /// Whether the active tool is locked ([`KitTools::lock_tool`]); answers carry it as `toolLocked`.
    fn tool_locked(&self) -> bool {
        false
    }
}

/// A document area an event changed, in document pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct ToolDamage {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl ToolDamage {
    /// No pixel changed: the empty area at the origin, which the page repaints nothing for.
    pub const NONE: ToolDamage = ToolDamage { x0: 0.0, y0: 0.0, x1: 0.0, y1: 0.0 };
}

/// The text caret, in document pixels: its top at (`x`, `y`), `height` tall, turned `angle`
/// degrees clockwise about its top (text on a rotated shape).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct ToolCaret {
    pub x: f64,
    pub y: f64,
    pub height: f64,
    pub angle: f64,
}

/// A tool's answer as the page reads it: the response, and `damage` when the event changed only
/// that area (or [`ToolDamage::NONE`], no pixel).
#[doc(hidden)]
pub fn __answer_json(response: &ToolResponse, damage: Option<ToolDamage>) -> Result<String, String> {
    serde_json::to_string(&answer_value(response, damage)?).map_err(|error| error.to_string())
}

fn answer_value(response: &ToolResponse, damage: Option<ToolDamage>) -> Result<serde_json::Value, String> {
    let mut value = serde_json::to_value(response).map_err(|error| error.to_string())?;
    let shown = |d: &ToolDamage| *d == ToolDamage::NONE || (d.x1 > d.x0 && d.y1 > d.y0 && [d.x0, d.y0, d.x1, d.y1].iter().all(|v| v.is_finite()));
    if let (Some(area), Some(object)) = (damage.filter(shown), value.as_object_mut()) {
        object.insert("damage".to_owned(), serde_json::to_value(area).map_err(|error| error.to_string())?);
    }
    Ok(value)
}

/// A tool's answer as the page reads it: [`__answer_json`] (with the area the event changed when
/// `event`; a state query takes none), and what the document says beside the response
/// (`takesKeys`, `caret`, `toolLocked`), each only when it has one.
#[doc(hidden)]
pub fn __tool_answer<T: KitTools + ?Sized>(document: &mut T, response: Result<ToolResponse, String>, event: bool) -> Result<String, String> {
    let damage = if event { document.take_damage() } else { None };
    let mut value = answer_value(&response?, damage)?;
    if let Some(object) = value.as_object_mut() {
        if document.takes_keys() {
            object.insert("takesKeys".to_owned(), serde_json::Value::Bool(true));
        }
        if let Some(caret) = document.caret().filter(|c| [c.x, c.y, c.height, c.angle].iter().all(|v| v.is_finite()) && c.height > 0.0) {
            object.insert("caret".to_owned(), serde_json::to_value(caret).map_err(|error| error.to_string())?);
        }
        if document.tool_locked() {
            object.insert("toolLocked".to_owned(), serde_json::Value::Bool(true));
        }
    }
    serde_json::to_string(&value).map_err(|error| error.to_string())
}

/// Exports a [`KitTools`] on the class [`crate::export_kit_document!`] made: `tools()`,
/// `tool()`, `selectTool(id, zoom, locked?)`, `pointer(eventJson)`, `toolKey(key, modsJson, zoom)`,
/// `toolText(text, zoom)`, `toolPreedit(text, cursor, zoom)` (nothing when the kit shows no
/// composition), and `toolState(x, y, modsJson, zoom)`, each answering JSON.
#[macro_export]
macro_rules! export_kit_tools {
    ($document:ident as $js_name:literal) => {
        $crate::__export_kit_tools_paste!($document, $js_name);
    };
}

#[doc(hidden)]
#[macro_export]
#[cfg(not(target_arch = "wasm32"))]
macro_rules! __export_kit_tools_paste {
    ($document:ident, $js_name:literal) => {};
}

#[doc(hidden)]
#[macro_export]
#[cfg(target_arch = "wasm32")]
macro_rules! __export_kit_tools_paste {
    ($document:ident, $js_name:literal) => {
        #[doc(hidden)]
        pub mod __kition_kit_tools_export {
            use $crate::__wasm_bindgen as wasm_bindgen;
            use $crate::__wasm_bindgen::prelude::*;
            use $crate::tools::{__tool_answer, KitTools, ToolMods, ToolPointer, ToolResponse};

            use super::__kition_kit_export::WebDocument;

            // Trait calls are fully qualified so a kit's own inherent methods of the same
            // name (a `state` helper, say) never shadow them.

            fn error(message: String) -> JsError {
                JsError::new(&message)
            }

            // The event's answer with the area it changed, when the kit knows it (`take_damage`),
            // and whether the tool takes keys, its caret and its lock.
            fn answer(document: &mut WebDocument, response: Result<ToolResponse, String>) -> Result<String, JsError> {
                __tool_answer(&mut document.0, response, true).map_err(error)
            }

            fn mods(json: &str) -> ToolMods {
                serde_json::from_str(json).unwrap_or_default()
            }

            #[wasm_bindgen(js_class = $js_name, wasm_bindgen = $crate::__wasm_bindgen)]
            impl WebDocument {
                pub fn tools(&self) -> String {
                    serde_json::to_string(&KitTools::tools(&self.0)).unwrap_or_else(|_| "[]".to_owned())
                }

                pub fn tool(&self) -> String {
                    KitTools::tool(&self.0)
                }

                /// `locked` (Lock Drawing Mode) is asked of the tool just chosen (`lock_tool`).
                #[wasm_bindgen(js_name = selectTool)]
                pub fn select_tool(&mut self, id: &str, zoom: f64, locked: Option<bool>) -> Result<String, JsError> {
                    let response = KitTools::select_tool(&mut self.0, id, zoom);
                    if let (Ok(_), Some(locked)) = (&response, locked) {
                        KitTools::lock_tool(&mut self.0, locked);
                    }
                    answer(self, response)
                }

                pub fn pointer(&mut self, event: &str) -> Result<String, JsError> {
                    let event: ToolPointer = serde_json::from_str(event).map_err(|problem| error(format!("not a pointer event: {problem}")))?;
                    let response = KitTools::pointer(&mut self.0, &event);
                    answer(self, response)
                }

                #[wasm_bindgen(js_name = toolKey)]
                pub fn tool_key(&mut self, key: &str, mods_json: &str, zoom: f64) -> Result<String, JsError> {
                    let response = KitTools::key(&mut self.0, key, mods(mods_json), zoom);
                    answer(self, response)
                }

                #[wasm_bindgen(js_name = toolText)]
                pub fn tool_text(&mut self, text: &str, zoom: f64) -> Result<String, JsError> {
                    let response = KitTools::text(&mut self.0, text, zoom);
                    answer(self, response)
                }

                /// The input method's composition; `undefined` when the kit shows none (`preedit`).
                #[wasm_bindgen(js_name = toolPreedit)]
                pub fn tool_preedit(&mut self, text: &str, cursor: u32, zoom: f64) -> Result<Option<String>, JsError> {
                    match KitTools::preedit(&mut self.0, text, cursor, zoom) {
                        Some(response) => answer(self, response).map(Some),
                        None => Ok(None),
                    }
                }

                #[wasm_bindgen(js_name = toolState)]
                pub fn tool_state(&mut self, x: f64, y: f64, mods_json: &str, zoom: f64) -> String {
                    let response = KitTools::state(&mut self.0, x, y, mods(mods_json), zoom);
                    __tool_answer(&mut self.0, Ok(response), false).unwrap_or_else(|_| "{}".to_owned())
                }
            }

            #[allow(unused_imports)]
            use wasm_bindgen as _;
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_carries_the_area_an_event_changed() {
        let response = ToolResponse { cursor: "text".into(), ..ToolResponse::default() };
        let with: serde_json::Value =
            serde_json::from_str(&__answer_json(&response, Some(ToolDamage { x0: 1.0, y0: 2.0, x1: 30.0, y1: 40.5 })).unwrap()).unwrap();
        assert_eq!(with["damage"], serde_json::json!({ "x0": 1.0, "y0": 2.0, "x1": 30.0, "y1": 40.5 }));
        assert_eq!(with["cursor"], "text");
        let without: serde_json::Value = serde_json::from_str(&__answer_json(&response, None).unwrap()).unwrap();
        assert!(without.get("damage").is_none());
        // An empty or broken area repaints everything.
        let empty: serde_json::Value =
            serde_json::from_str(&__answer_json(&response, Some(ToolDamage { x0: 5.0, y0: 5.0, x1: 5.0, y1: 9.0 })).unwrap()).unwrap();
        assert!(empty.get("damage").is_none());
        let nan: serde_json::Value =
            serde_json::from_str(&__answer_json(&response, Some(ToolDamage { x0: f64::NAN, y0: 0.0, x1: 1.0, y1: 1.0 })).unwrap()).unwrap();
        assert!(nan.get("damage").is_none());
    }

    #[test]
    fn a_press_says_its_button_and_click_count() {
        let triple: ToolPointer = serde_json::from_str(r#"{"action":"down","x":1,"y":2,"zoom":1,"clicks":3}"#).unwrap();
        assert_eq!(triple.clicks, 3);
        assert_eq!(triple.button, PointerButton::Primary);
        let right: ToolPointer = serde_json::from_str(r#"{"action":"up","x":1,"y":2,"zoom":1,"button":"secondary"}"#).unwrap();
        assert_eq!(right.button, PointerButton::Secondary);
        assert_eq!(right.clicks, 1, "an event without a count is one click");
        assert!(serde_json::from_str::<ToolPointer>(r#"{"action":"down","x":0,"y":0,"zoom":1,"button":"fourth"}"#).is_err());
    }

    #[test]
    fn an_answer_can_say_no_pixel_changed() {
        let response = ToolResponse::default();
        let none: serde_json::Value = serde_json::from_str(&__answer_json(&response, Some(ToolDamage::NONE)).unwrap()).unwrap();
        assert_eq!(none["damage"], serde_json::json!({ "x0": 0.0, "y0": 0.0, "x1": 0.0, "y1": 0.0 }));
    }

    /// A tool that takes keys, has a caret, keeps a lock and shows compositions.
    #[derive(Default)]
    struct Typing {
        locked: bool,
        composing: String,
        damage: Option<ToolDamage>,
    }

    impl KitTools for Typing {
        fn tools(&self) -> Vec<ToolInfo> {
            Vec::new()
        }
        fn tool(&self) -> String {
            "text".into()
        }
        fn select_tool(&mut self, _id: &str, _zoom: f64) -> Result<ToolResponse, String> {
            self.locked = false;
            Ok(ToolResponse::default())
        }
        fn pointer(&mut self, _event: &ToolPointer) -> Result<ToolResponse, String> {
            self.damage = Some(ToolDamage { x0: 1.0, y0: 1.0, x1: 2.0, y1: 2.0 });
            Ok(ToolResponse::default())
        }
        fn key(&mut self, _key: &str, _mods: ToolMods, _zoom: f64) -> Result<ToolResponse, String> {
            Ok(ToolResponse::default())
        }
        fn text(&mut self, _text: &str, _zoom: f64) -> Result<ToolResponse, String> {
            Ok(ToolResponse::default())
        }
        fn state(&mut self, _x: f64, _y: f64, _mods: ToolMods, _zoom: f64) -> ToolResponse {
            ToolResponse::default()
        }
        fn take_damage(&mut self) -> Option<ToolDamage> {
            self.damage.take()
        }
        fn takes_keys(&self) -> bool {
            true
        }
        fn caret(&self) -> Option<ToolCaret> {
            Some(ToolCaret { x: 10.0, y: 20.0, height: 14.0, angle: 0.0 })
        }
        fn preedit(&mut self, text: &str, _cursor: u32, _zoom: f64) -> Option<Result<ToolResponse, String>> {
            self.composing = text.to_owned();
            Some(Ok(ToolResponse::default()))
        }
        fn lock_tool(&mut self, locked: bool) {
            self.locked = locked;
        }
        fn tool_locked(&self) -> bool {
            self.locked
        }
    }

    #[test]
    fn an_answer_carries_keys_caret_and_lock_beside_the_response() {
        let mut typing = Typing::default();
        typing.lock_tool(true);
        let event = |doc: &mut Typing| {
            let response = doc.pointer(&serde_json::from_str(r#"{"action":"down","x":1,"y":1,"zoom":1}"#).unwrap());
            serde_json::from_str::<serde_json::Value>(&__tool_answer(doc, response, true).unwrap()).unwrap()
        };
        let answer = event(&mut typing);
        assert_eq!(answer["takesKeys"], true);
        assert_eq!(answer["toolLocked"], true);
        assert_eq!(answer["caret"], serde_json::json!({ "x": 10.0, "y": 20.0, "height": 14.0, "angle": 0.0 }));
        assert_eq!(answer["damage"]["x1"], 2.0);
        // A state query takes no damage: the next event's stays owed to it.
        typing.damage = Some(ToolDamage::NONE);
        let state = serde_json::from_str::<serde_json::Value>(&__tool_answer(&mut typing, Ok(ToolResponse::default()), false).unwrap()).unwrap();
        assert!(state.get("damage").is_none());
        assert_eq!(typing.damage, Some(ToolDamage::NONE));
        // A tool chosen again drops its lock; the answer says so by leaving it out.
        let chosen = typing.select_tool("text", 1.0);
        let answer = serde_json::from_str::<serde_json::Value>(&__tool_answer(&mut typing, chosen, true).unwrap()).unwrap();
        assert!(answer.get("toolLocked").is_none());
        assert!(typing.preedit("ni", 2, 1.0).is_some());
        assert_eq!(typing.composing, "ni");
        // A failed event is an error, whatever the document says beside it.
        assert!(__tool_answer(&mut typing, Err("no".into()), true).is_err());
    }

    #[test]
    fn a_tool_by_default_takes_no_keys_has_no_caret_lock_or_composition() {
        struct Plain;
        impl KitTools for Plain {
            fn tools(&self) -> Vec<ToolInfo> {
                Vec::new()
            }
            fn tool(&self) -> String {
                String::new()
            }
            fn select_tool(&mut self, _id: &str, _zoom: f64) -> Result<ToolResponse, String> {
                Ok(ToolResponse::default())
            }
            fn pointer(&mut self, _event: &ToolPointer) -> Result<ToolResponse, String> {
                Ok(ToolResponse::default())
            }
            fn key(&mut self, _key: &str, _mods: ToolMods, _zoom: f64) -> Result<ToolResponse, String> {
                Ok(ToolResponse::default())
            }
            fn text(&mut self, _text: &str, _zoom: f64) -> Result<ToolResponse, String> {
                Ok(ToolResponse::default())
            }
            fn state(&mut self, _x: f64, _y: f64, _mods: ToolMods, _zoom: f64) -> ToolResponse {
                ToolResponse::default()
            }
        }
        let mut plain = Plain;
        plain.lock_tool(true);
        assert!(!plain.tool_locked());
        assert!(plain.preedit("ni", 2, 1.0).is_none());
        let answer = serde_json::from_str::<serde_json::Value>(&__tool_answer(&mut plain, Ok(ToolResponse::default()), true).unwrap()).unwrap();
        for absent in ["takesKeys", "caret", "toolLocked", "damage"] {
            assert!(answer.get(absent).is_none(), "{absent}");
        }
    }

    #[test]
    fn events_and_answers_have_a_stable_json_shape() {
        let event: ToolPointer = serde_json::from_str(r#"{"action":"drag","x":4.5,"y":2,"mods":{"shift":true},"zoom":2}"#).unwrap();
        assert_eq!(event.action, PointerAction::Drag);
        assert!(event.mods.shift && !event.mods.alt);
        assert!((event.pressure - 1.0).abs() < f32::EPSILON, "pressure defaults to 1");
        let response = ToolResponse {
            requests: vec![ToolRequest::SwitchTool { id: "selection".into() }],
            overlays: vec![ToolOverlay::Marquee { x0: 0.0, y0: 0.0, x1: 4.0, y1: 3.0 }],
            cursor: "crosshair".into(),
            busy: true,
            wants_text: false,
        };
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["requests"][0], serde_json::json!({ "kind": "switchTool", "id": "selection" }));
        assert_eq!(json["overlays"][0]["kind"], "marquee");
        assert_eq!(json["wantsText"], false);
        let ants = serde_json::to_value(ToolOverlay::Ants { d: "M0,0 L4,0".into(), color: [0, 0, 0, 255], width: 1.0 }).unwrap();
        assert_eq!(ants, serde_json::json!({ "kind": "ants", "d": "M0,0 L4,0", "color": [0, 0, 0, 255], "width": 1.0 }));
        assert!(serde_json::from_str::<ToolPointer>(r#"{"action":"fly","x":0,"y":0,"zoom":1}"#).is_err());
    }
}
