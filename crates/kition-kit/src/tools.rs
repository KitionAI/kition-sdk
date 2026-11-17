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
}

fn full_pressure() -> f32 {
    1.0
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
    /// (the default) repaints everything when the document changed.
    fn take_damage(&mut self) -> Option<ToolDamage> {
        None
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

/// A tool's answer as the page reads it: the response, and `damage` when the event changed only
/// that area.
#[doc(hidden)]
pub fn __answer_json(response: &ToolResponse, damage: Option<ToolDamage>) -> Result<String, String> {
    let mut value = serde_json::to_value(response).map_err(|error| error.to_string())?;
    if let (Some(area), Some(object)) =
        (damage.filter(|d| d.x1 > d.x0 && d.y1 > d.y0 && [d.x0, d.y0, d.x1, d.y1].iter().all(|v| v.is_finite())), value.as_object_mut())
    {
        object.insert("damage".to_owned(), serde_json::to_value(area).map_err(|error| error.to_string())?);
    }
    serde_json::to_string(&value).map_err(|error| error.to_string())
}

/// Exports a [`KitTools`] on the class [`crate::export_kit_document!`] made: `tools()`,
/// `tool()`, `selectTool(id, zoom)`, `pointer(eventJson)`, `toolKey(key, modsJson, zoom)`,
/// `toolText(text, zoom)`, and `toolState(x, y, modsJson, zoom)`, each answering JSON.
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
            use $crate::tools::{__answer_json, KitTools, ToolMods, ToolPointer, ToolResponse};

            use super::__kition_kit_export::WebDocument;

            // Trait calls are fully qualified so a kit's own inherent methods of the same
            // name (a `state` helper, say) never shadow them.

            fn error(message: String) -> JsError {
                JsError::new(&message)
            }

            // The event's answer with the area it changed, when the kit knows it (`take_damage`).
            fn answer(document: &mut WebDocument, response: Result<ToolResponse, String>) -> Result<String, JsError> {
                let damage = KitTools::take_damage(&mut document.0);
                response.and_then(|value| __answer_json(&value, damage)).map_err(error)
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

                #[wasm_bindgen(js_name = selectTool)]
                pub fn select_tool(&mut self, id: &str, zoom: f64) -> Result<String, JsError> {
                    let response = KitTools::select_tool(&mut self.0, id, zoom);
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

                #[wasm_bindgen(js_name = toolState)]
                pub fn tool_state(&mut self, x: f64, y: f64, mods_json: &str, zoom: f64) -> String {
                    serde_json::to_string(&KitTools::state(&mut self.0, x, y, mods(mods_json), zoom)).unwrap_or_else(|_| "{}".to_owned())
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
        assert!(serde_json::from_str::<ToolPointer>(r#"{"action":"fly","x":0,"y":0,"zoom":1}"#).is_err());
    }
}
