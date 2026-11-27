//! Diagnostics (Kit Harness Protocol (KHP) Verify, A21): what a kit finds wrong with a document, so an agent
//! can check its own output and a host can show it. [`KitDocument::check`](crate::KitDocument::check)
//! answers them; hosts reach it as `<prefix>_check`, the Kit Process Protocol's `file.check`, and the
//! Kit UI protocol's `document/check`, which all answer the same JSON.
//!
//! ```
//! use kition_kit::diagnostics::{Diagnostic, Severity, Target};
//! let found = Diagnostic::new("slide.text-overflow", Severity::Warning, "The text does not fit its box.")
//!     .on(Target { slide: Some(2), object_id: Some("shape-7".into()), ..Target::default() });
//! assert_eq!(serde_json::to_value(&found).unwrap()["target"]["slide"], 2);
//! ```

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How much a diagnostic matters.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// The document is broken or will not show as meant (a formula error, a missing picture).
    Error,
    /// Probably not what the author meant (text that overflows its box, a substituted font).
    Warning,
    /// Worth knowing, nothing to fix (an empty placeholder that does not show in the show).
    Info,
}

/// What a diagnostic is about. Every field is optional; none set means the whole document.
/// Numbers count from 1, as people see them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// The object's id in the kit's object model (`model.describe`), when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    /// A path inside the document: a part (`ppt/slides/slide3.xml`), a layer path, or a field
    /// path from the root (`slides.2.shapes.4`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slide: Option<u32>,
    /// The sheet's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
    /// A cell or range in A1 notation (`B7`, `A1:C4`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell: Option<String>,
}

/// A command that would fix the diagnostic: a hint for the agent, never run by the host on its own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Fix {
    /// An engine command id, as `<prefix>_run` takes it.
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

/// One thing a kit found in a document.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    /// Stable across versions, `<kit>.<name>` in lowercase with hyphens
    /// (`sheet.formula-error`): agents and tests match on it, never on the message.
    pub code: String,
    pub severity: Severity,
    #[serde(default)]
    pub target: Target,
    /// One English sentence for people and models.
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<Fix>,
}

impl Diagnostic {
    /// A diagnostic about the whole document; add a target with [`Diagnostic::on`].
    pub fn new(code: impl Into<String>, severity: Severity, message: impl Into<String>) -> Self {
        Self { code: code.into(), severity, target: Target::default(), message: message.into(), fix: None }
    }

    #[must_use]
    pub fn on(mut self, target: Target) -> Self {
        self.target = target;
        self
    }

    #[must_use]
    pub fn fix(mut self, command: impl Into<String>, params: Option<Value>) -> Self {
        self.fix = Some(Fix { command: command.into(), params });
        self
    }
}

/// The diagnostics as the JSON every host answers: `{ "diagnostics": [...] }`, errors first.
pub fn report(diagnostics: &[Diagnostic]) -> Value {
    let mut sorted = diagnostics.to_vec();
    sorted.sort_by_key(|diagnostic| diagnostic.severity);
    serde_json::json!({ "diagnostics": sorted })
}

/// Whether `code` is a well-formed diagnostic code: two or more dot-separated words of lowercase
/// ASCII letters, digits, and inner hyphens.
pub fn valid_code(code: &str) -> bool {
    let words: Vec<&str> = code.split('.').collect();
    words.len() >= 2
        && words.iter().all(|word| {
            !word.is_empty()
                && !word.starts_with('-')
                && !word.ends_with('-')
                && word.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// Checks diagnostics against the rules above: a valid code, a message, a fix naming a command,
/// numbers counted from 1.
pub fn check_diagnostics(diagnostics: &[Diagnostic]) -> Result<(), String> {
    for diagnostic in diagnostics {
        let code = &diagnostic.code;
        if !valid_code(code) {
            return Err(format!("diagnostic code `{code}` is not `<kit>.<name>` in lowercase with hyphens"));
        }
        if diagnostic.message.trim().is_empty() {
            return Err(format!("diagnostic `{code}` has no message"));
        }
        if diagnostic.fix.as_ref().is_some_and(|fix| fix.command.trim().is_empty()) {
            return Err(format!("diagnostic `{code}` has a fix without a command"));
        }
        let target = &diagnostic.target;
        if target.page == Some(0) || target.slide == Some(0) {
            return Err(format!("diagnostic `{code}` counts pages or slides from 0; they count from 1"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_dotted_lowercase_words() {
        for good in ["sheet.formula-error", "slide.text-overflow", "kit.a1.b-2"] {
            assert!(valid_code(good), "{good}");
        }
        for bad in ["overflow", "Slide.overflow", "slide..x", "slide.-x", "slide.x-", "slide.x_y", ""] {
            assert!(!valid_code(bad), "{bad}");
        }
    }

    #[test]
    fn the_report_puts_errors_first_and_omits_empty_fields() {
        let found = [
            Diagnostic::new("slide.empty-placeholder", Severity::Info, "An empty placeholder."),
            Diagnostic::new("slide.missing-media", Severity::Error, "A picture is missing.")
                .on(Target { slide: Some(3), ..Target::default() })
                .fix("shape.delete", Some(serde_json::json!({ "id": "p1" }))),
        ];
        let report = report(&found);
        let first = &report["diagnostics"][0];
        assert_eq!(first["code"], "slide.missing-media");
        assert_eq!(first["severity"], "error");
        assert_eq!(first["target"], serde_json::json!({ "slide": 3 }));
        assert_eq!(first["fix"]["command"], "shape.delete");
        assert_eq!(report["diagnostics"][1]["target"], serde_json::json!({}));
        assert!(report["diagnostics"][1].get("fix").is_none());
    }

    #[test]
    fn diagnostics_round_trip_and_are_checked() {
        let found = Diagnostic::new("sheet.formula-error", Severity::Error, "B2 is #REF!.").on(Target {
            sheet: Some("Sheet1".into()),
            cell: Some("B2".into()),
            ..Target::default()
        });
        let back: Diagnostic = serde_json::from_value(serde_json::to_value(&found).unwrap_or_default()).unwrap_or_else(|_| found.clone());
        assert_eq!(back, found);
        assert!(check_diagnostics(std::slice::from_ref(&found)).is_ok());
        let zero = Diagnostic::new("slide.x", Severity::Info, "x").on(Target { slide: Some(0), ..Target::default() });
        assert!(check_diagnostics(&[zero]).is_err());
        assert!(check_diagnostics(&[Diagnostic::new("slide.x", Severity::Info, " ")]).is_err());
        assert!(check_diagnostics(&[Diagnostic::new("slide.x", Severity::Info, "x").fix("", None)]).is_err());
    }
}
