//! The contract 2 members of the JavaScript class, as plain functions the export macro wraps.

use kition_kdm::{Origin, UndoScope, Version};
use serde_json::{Value, json};

use super::{Damage, KitModel, KitSession};
use crate::KitDocument;

/// A contract 1 document whose state lives in a [`KitSession`]. Export it with
/// [`export_kit_session!`](crate::export_kit_session) after
/// [`export_kit_document!`](crate::export_kit_document); contract 1 members stay as they are.
///
/// The provided methods go through the session; override them to keep a kit's own state (a
/// revision counter) current.
pub trait KitSessionDocument: KitDocument {
    type Model: KitModel;

    fn session(&self) -> &KitSession<Self::Model>;

    fn session_mut(&mut self) -> &mut KitSession<Self::Model>;

    /// Runs a command as `origin`; contract 1's `execute` is this with the host's person.
    fn execute_as(&mut self, command: &str, params: Value, origin: &Origin) -> Result<Value, String>;

    fn import_changes(&mut self, bytes: &[u8]) -> Result<Damage, String> {
        Ok(self.session_mut().import_changes(bytes)?)
    }

    fn undo(&mut self) -> Result<(bool, Damage), String> {
        Ok(self.session_mut().undo()?)
    }

    fn redo(&mut self) -> Result<(bool, Damage), String> {
        Ok(self.session_mut().redo()?)
    }

    /// `edit.undo` in `scope` (KitModel M12a; [`super::history_scope`] reads it from the command):
    /// the person's is [`KitSessionDocument::undo`]. A kit that keeps its own state current in
    /// `undo` overrides this too.
    fn undo_in(&mut self, scope: UndoScope) -> Result<(bool, Damage), String> {
        match scope {
            UndoScope::Person => self.undo(),
            UndoScope::Agent => Ok(self.session_mut().undo_in(scope)?),
        }
    }

    /// `edit.redo` in `scope`, like [`KitSessionDocument::undo_in`].
    fn redo_in(&mut self, scope: UndoScope) -> Result<(bool, Damage), String> {
        match scope {
            UndoScope::Person => self.redo(),
            UndoScope::Agent => Ok(self.session_mut().redo_in(scope)?),
        }
    }
}

#[doc(hidden)]
pub fn __version<D: KitSessionDocument>(document: &D) -> Vec<u8> {
    document.session().version().encode()
}

/// Empty `since` bytes ask for every change.
#[doc(hidden)]
pub fn __export_changes<D: KitSessionDocument>(document: &D, since: &[u8]) -> Result<Vec<u8>, String> {
    let since = if since.is_empty() { Version::empty() } else { Version::decode(since).map_err(|error| error.to_string())? };
    Ok(document.session().export_changes(&since)?)
}

#[doc(hidden)]
pub fn __import_changes<D: KitSessionDocument>(document: &mut D, bytes: &[u8]) -> Result<String, String> {
    KitSessionDocument::import_changes(document, bytes).map(|damage| super::json(&damage))
}

#[doc(hidden)]
pub fn __snapshot<D: KitSessionDocument>(document: &D) -> Result<Vec<u8>, String> {
    Ok(document.session().snapshot()?)
}

/// `{"done": bool, "damage": Damage}`.
#[doc(hidden)]
pub fn __undo<D: KitSessionDocument>(document: &mut D) -> Result<String, String> {
    KitSessionDocument::undo(document).map(|(done, damage)| json!({ "done": done, "damage": damage }).to_string())
}

#[doc(hidden)]
pub fn __redo<D: KitSessionDocument>(document: &mut D) -> Result<String, String> {
    KitSessionDocument::redo(document).map(|(done, damage)| json!({ "done": done, "damage": damage }).to_string())
}

#[doc(hidden)]
pub fn __can_undo<D: KitSessionDocument>(document: &D) -> bool {
    document.session().can_undo()
}

#[doc(hidden)]
pub fn __can_redo<D: KitSessionDocument>(document: &D) -> bool {
    document.session().can_redo()
}

/// The schema version the replica reads (its kit's `model.schemaVersion`).
#[doc(hidden)]
pub fn __schema_version<D: KitSessionDocument>(document: &D) -> u32 {
    document.session().replica().schema().schema_version
}

/// The newest schema version any of the replica's changes was written under (standard 2.0 rule
/// M5a), or `None` when none records one.
#[doc(hidden)]
pub fn __author_schema_version<D: KitSessionDocument>(document: &D) -> Option<u32> {
    document.session().replica().author_schema_version()
}

/// `origin` is the KDM's commit form, the JSON array `[kind, principal, label]`.
#[doc(hidden)]
pub fn __execute_as<D: KitSessionDocument>(document: &mut D, command: &str, params: &str, origin: &str) -> Result<String, String> {
    let params = crate::parse_params(params)?;
    let origin = Origin::decode(origin).ok_or_else(|| format!("origin is not [kind, principal, label]: {origin}"))?;
    KitSessionDocument::execute_as(document, command, params, &origin).map(|value| value.to_string())
}

/// `model/describe` as JSON text.
#[doc(hidden)]
pub fn __model_describe<D: KitSessionDocument>(document: &D) -> String {
    super::model::session_describe(document).to_string()
}

/// `model/batch`: the request and the answer as JSON text; a failure's message is the error's JSON
/// (`{"code", "index", "message"}`).
#[doc(hidden)]
pub fn __model_batch<D: KitSessionDocument>(document: &mut D, request: &str) -> Result<String, String> {
    let request: Value = serde_json::from_str(request)
        .map_err(|error| json!({ "code": "invalid-op", "index": null, "message": format!("the batch is not JSON: {error}") }).to_string())?;
    super::model::session_batch(document, &request, false).map(|answer| answer.to_string()).map_err(|error| error.to_json().to_string())
}

/// Adds the contract 2 members to the class [`export_kit_document!`](crate::export_kit_document)
/// made, for a [`KitSessionDocument`]: `version()`, `exportChanges(since)`, and `snapshot()` as
/// bytes; `importChanges(bytes)` answering damage JSON; `undo()` and `redo()` answering
/// `{"done", "damage"}`; `canUndo()`, `canRedo()`; `executeAs(command, params, origin)`; and the
/// object model, `modelDescribe()` and `modelBatch(request)` (JSON text in and out).
#[macro_export]
macro_rules! export_kit_session {
    ($document:ident as $js_name:literal) => {
        $crate::__export_kit_session_paste!($document, $js_name);
    };
}

#[doc(hidden)]
#[macro_export]
#[cfg(not(target_arch = "wasm32"))]
macro_rules! __export_kit_session_paste {
    ($document:ident, $js_name:literal) => {};
}

#[doc(hidden)]
#[macro_export]
#[cfg(target_arch = "wasm32")]
macro_rules! __export_kit_session_paste {
    ($document:ident, $js_name:literal) => {
        #[doc(hidden)]
        pub mod __kition_kit_session_export {
            use $crate::__wasm_bindgen as wasm_bindgen;
            use $crate::__wasm_bindgen::prelude::*;
            use $crate::session;

            use super::__kition_kit_export::WebDocument;

            fn error(message: String) -> JsError {
                JsError::new(&message)
            }

            #[wasm_bindgen(js_class = $js_name, wasm_bindgen = $crate::__wasm_bindgen)]
            impl WebDocument {
                pub fn version(&self) -> Vec<u8> {
                    session::__version(&self.0)
                }

                #[wasm_bindgen(js_name = exportChanges)]
                pub fn export_changes(&self, since: &[u8]) -> Result<Vec<u8>, JsError> {
                    session::__export_changes(&self.0, since).map_err(error)
                }

                #[wasm_bindgen(js_name = importChanges)]
                pub fn import_changes(&mut self, bytes: &[u8]) -> Result<String, JsError> {
                    session::__import_changes(&mut self.0, bytes).map_err(error)
                }

                pub fn snapshot(&self) -> Result<Vec<u8>, JsError> {
                    session::__snapshot(&self.0).map_err(error)
                }

                pub fn undo(&mut self) -> Result<String, JsError> {
                    session::__undo(&mut self.0).map_err(error)
                }

                pub fn redo(&mut self) -> Result<String, JsError> {
                    session::__redo(&mut self.0).map_err(error)
                }

                #[wasm_bindgen(js_name = canUndo)]
                pub fn can_undo(&self) -> bool {
                    session::__can_undo(&self.0)
                }

                #[wasm_bindgen(js_name = canRedo)]
                pub fn can_redo(&self) -> bool {
                    session::__can_redo(&self.0)
                }

                #[wasm_bindgen(js_name = schemaVersion)]
                pub fn schema_version(&self) -> u32 {
                    session::__schema_version(&self.0)
                }

                #[wasm_bindgen(js_name = authorSchemaVersion)]
                pub fn author_schema_version(&self) -> Option<u32> {
                    session::__author_schema_version(&self.0)
                }

                #[wasm_bindgen(js_name = executeAs)]
                pub fn execute_as(&mut self, command: &str, params: &str, origin: &str) -> Result<String, JsError> {
                    session::__execute_as(&mut self.0, command, params, origin).map_err(error)
                }

                #[wasm_bindgen(js_name = modelDescribe)]
                pub fn model_describe(&self) -> String {
                    session::__model_describe(&self.0)
                }

                #[wasm_bindgen(js_name = modelBatch)]
                pub fn model_batch(&mut self, request: &str) -> Result<String, JsError> {
                    session::__model_batch(&mut self.0, request).map_err(error)
                }
            }

            #[allow(unused_imports)]
            use wasm_bindgen as _;
        }
    };
}
