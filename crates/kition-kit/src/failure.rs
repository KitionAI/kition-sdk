//! Why a command did not run, as a kit says it, typed.
//!
//! A kit's [`crate::KitDocument::execute`] answers an error as a `String`, which crosses the
//! WebAssembly boundary as it is. A host that must answer an error code (the Kit Process Protocol's
//! `command_not_found`, `command_disabled`, `invalid_params`, section 10) would otherwise guess it
//! from the message's wording. A kit says it instead by returning [`failure`]'s message: the text
//! a person reads, then the reason after a separator ([`FAILURE_SEPARATOR`]) that [`parse_failure`]
//! reads back. A host takes the reason from there, and guesses from the wording only for a message
//! that carries none.

/// Separates a [`failure`]'s text from its reason: the ASCII unit separator, which no message a
/// person reads holds.
pub const FAILURE_SEPARATOR: char = '\u{1f}';

/// Why a command did not run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandFailure {
    /// The kit has no such command.
    NotFound,
    /// The command exists and cannot run now (nothing selected, a locked object, a read-only part).
    Disabled,
    /// The command's parameters are wrong.
    InvalidParams,
}

impl CommandFailure {
    const ALL: [Self; 3] = [Self::NotFound, Self::Disabled, Self::InvalidParams];

    /// The reason's name after the separator, as the protocol spells it.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::NotFound => "command_not_found",
            Self::Disabled => "command_disabled",
            Self::InvalidParams => "invalid_params",
        }
    }
}

/// The error message for a command that did not run for `reason`: `message`, then the reason.
#[must_use]
pub fn failure(reason: CommandFailure, message: impl std::fmt::Display) -> String {
    format!("{message}{FAILURE_SEPARATOR}{}", reason.name())
}

/// A [`failure`]'s text and reason; `None` for a message that carries no reason.
#[must_use]
pub fn parse_failure(message: &str) -> Option<(&str, CommandFailure)> {
    let (text, name) = message.rsplit_once(FAILURE_SEPARATOR)?;
    CommandFailure::ALL.into_iter().find(|reason| reason.name() == name).map(|reason| (text, reason))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_carries_its_reason_and_its_text() {
        let message = failure(CommandFailure::Disabled, "unknown command wording does not decide it");
        assert_eq!(parse_failure(&message), Some(("unknown command wording does not decide it", CommandFailure::Disabled)));
        assert_eq!(parse_failure("no such command"), None);
    }
}
