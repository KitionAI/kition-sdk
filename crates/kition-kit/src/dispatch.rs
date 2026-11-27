//! Who a command runs for, and the one gate every way of running a command passes (KHP A28, A29,
//! §10.6).
//!
//! A host that serves a kit (kition-headless) checks each command before the engine runs it: the
//! command exists, the caller may run it (a command whose parameters name files is not offered,
//! nor one the manifest keeps from the agent), and its parameters fit its schema. It does so for
//! `command.execute` and for each `command` operation of an object-model batch, and while the
//! engine runs it keeps the same check here, for the caller's [`Role`], so that what the engine
//! dispatches itself goes through it too.
//!
//! A kit command that runs other commands (a batch of steps, a macro, a script) MUST ask
//! [`may_run`] before each step it dispatches and fail the call when it answers an error:
//!
//! ```ignore
//! for step in steps {
//!     kition_kit::dispatch::may_run(&step.command, &step.params)?;
//!     self.execute(&step.command, step.params)?;
//! }
//! ```
//!
//! Without a host (the page's worker, a kit's own tests) no gate is set and [`may_run`] allows
//! everything. [`crate::testing::check_nested_dispatch_is_gated`] checks that a kit's
//! dispatchers ask.

use std::cell::RefCell;
use std::sync::Arc;

use serde_json::Value;

use crate::schema::ParamError;

/// Who a call runs for: the person, an agent acting for them (KHP A11), or the host on the
/// person's behalf (origin `system`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Person,
    Agent,
    System,
}

/// Why the gate refused a command, as the agent's tools name it (KHP A18).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefusalCode {
    /// No command has this id (`unknown-command`).
    UnknownCommand,
    /// The command exists, but this caller may not run it (`not-allowed`).
    NotAllowed,
    /// The parameters do not fit the command's schema (`invalid-params`).
    InvalidParams,
}

impl RefusalCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownCommand => "unknown-command",
            Self::NotAllowed => "not-allowed",
            Self::InvalidParams => "invalid-params",
        }
    }
}

/// A command the gate refused: the code, the command, what to tell the caller, and for
/// `invalid-params` each wrong parameter.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    pub code: RefusalCode,
    pub command: String,
    pub message: String,
    pub errors: Vec<ParamError>,
}

impl Refusal {
    pub fn new(code: RefusalCode, command: &str, message: impl Into<String>) -> Self {
        Self { code, command: command.to_owned(), message: message.into(), errors: Vec::new() }
    }
}

/// The check a host applies to every command a caller runs.
pub trait Gate {
    /// Whom the call runs for.
    fn role(&self) -> Role;
    /// Whether `command` may run with `params` for this caller.
    fn check(&self, command: &str, params: &Value) -> Result<(), Refusal>;
}

thread_local! {
    static GATE: RefCell<Option<Arc<dyn Gate>>> = const { RefCell::new(None) };
    static REFUSED: RefCell<Option<Refusal>> = const { RefCell::new(None) };
}

/// Runs `run` with `gate` as the gate of the commands it dispatches on this thread; the gate set
/// before comes back afterwards, even when `run` panics. The outermost call forgets the refusal a
/// call before it left ([`take_refusal`]).
pub fn with_gate<T>(gate: Arc<dyn Gate>, run: impl FnOnce() -> T) -> T {
    struct Restore(Option<Arc<dyn Gate>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let previous = self.0.take();
            GATE.with(|slot| *slot.borrow_mut() = previous);
        }
    }
    let previous = GATE.with(|slot| slot.borrow_mut().replace(gate));
    if previous.is_none() {
        REFUSED.with(|slot| slot.borrow_mut().take());
    }
    let _restore = Restore(previous);
    run()
}

/// Whom the call the engine is running is for; `None` when no host set a gate.
#[must_use]
pub fn role() -> Option<Role> {
    let gate = GATE.with(|slot| slot.borrow().clone());
    gate.map(|gate| gate.role())
}

/// Whether the engine may run `command` with `params` now, for the caller the host runs it for: a
/// kit's own batch, macro, or script command asks before every step it dispatches, and fails with
/// the message when it may not (module docs). Without a gate everything may run.
pub fn may_run(command: &str, params: &Value) -> Result<(), String> {
    let gate = GATE.with(|slot| slot.borrow().clone());
    let Some(gate) = gate else { return Ok(()) };
    gate.check(command, params).map_err(|refusal| {
        let message = format!("`{}`: {}", refusal.command, refusal.message);
        REFUSED.with(|slot| {
            slot.borrow_mut().get_or_insert(refusal);
        });
        message
    })
}

/// The first refusal [`may_run`] answered inside the current [`with_gate`], forgotten once taken:
/// the host answers it rather than the engine's message about it.
#[must_use]
pub fn take_refusal() -> Option<Refusal> {
    REFUSED.with(|slot| slot.borrow_mut().take())
}

/// Whether the command id `text` matches `pattern`, where `*` stands for any run of characters:
/// the manifest's `agent.include` and `agent.exclude` patterns (`file.save*`), as
/// `tools/check-manifest.mjs` reads them.
#[must_use]
pub fn pattern_matches(pattern: &str, text: &str) -> bool {
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = text.strip_prefix(first) else { return false };
    let parts: Vec<&str> = parts.collect();
    let Some((last, middle)) = parts.split_last() else { return rest.is_empty() };
    for part in middle {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Only(&'static str, Role);

    impl Gate for Only {
        fn role(&self) -> Role {
            self.1
        }
        fn check(&self, command: &str, _params: &Value) -> Result<(), Refusal> {
            if command == self.0 { Ok(()) } else { Err(Refusal::new(RefusalCode::NotAllowed, command, "not for this caller")) }
        }
    }

    #[test]
    fn without_a_gate_everything_may_run() {
        assert_eq!(role(), None);
        assert!(may_run("file.export", &json!({ "path": "/x" })).is_ok());
        assert_eq!(take_refusal(), None);
    }

    #[test]
    fn a_gate_holds_for_what_runs_inside_it_and_its_first_refusal_is_kept() {
        let answered = with_gate(Arc::new(Only("text.insert", Role::Agent)), || {
            assert_eq!(role(), Some(Role::Agent));
            assert!(may_run("text.insert", &json!({})).is_ok());
            let refused = may_run("file.export", &json!({})).unwrap_err();
            assert!(refused.contains("`file.export`") && refused.contains("not for this caller"), "{refused}");
            let _ = may_run("file.open", &json!({}));
            // A gate set inside another holds there, and the outer one comes back.
            with_gate(Arc::new(Only("file.open", Role::Person)), || assert!(may_run("file.open", &json!({})).is_ok()));
            assert_eq!(role(), Some(Role::Agent));
            take_refusal()
        });
        assert_eq!(answered.map(|refusal| refusal.command), Some("file.export".to_owned()));
        assert_eq!(role(), None, "the gate ends with the call");
    }
}
