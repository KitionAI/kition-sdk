//! A download's progress on stderr, on one line written over as it goes: only when stderr is a
//! terminal, so scripts and `kition mcp`'s output see nothing of it.

use std::io::{IsTerminal, Write};
use std::time::{Duration, Instant};

/// How often the line is written again at most.
const EVERY: Duration = Duration::from_millis(100);

pub struct Progress {
    name: String,
    on: bool,
    shown: bool,
    last: Option<Instant>,
}

impl Progress {
    /// The progress of downloading `name`, shown when stderr is a terminal.
    pub fn new(name: &str) -> Self {
        Self { name: name.to_owned(), on: std::io::stderr().is_terminal(), shown: false, last: None }
    }

    /// `done` bytes of `total` downloaded.
    pub fn update(&mut self, done: u64, total: u64) {
        if !self.on || (done < total && self.last.is_some_and(|last| last.elapsed() < EVERY)) {
            return;
        }
        self.last = Some(Instant::now());
        self.shown = true;
        let mut stderr = std::io::stderr().lock();
        let _ = write!(stderr, "\r\x1b[2K{}", line(&self.name, done, total));
        let _ = stderr.flush();
    }

    /// Clears the line, so what follows starts on a clean one.
    pub fn finish(&mut self) {
        if self.shown {
            let mut stderr = std::io::stderr().lock();
            let _ = write!(stderr, "\r\x1b[2K");
            let _ = stderr.flush();
            self.shown = false;
        }
    }
}

impl Drop for Progress {
    fn drop(&mut self) {
        self.finish();
    }
}

/// The progress line: `note  4.2 MB / 11.0 MB  38%`.
pub fn line(name: &str, done: u64, total: u64) -> String {
    let percent = (done.saturating_mul(100)).checked_div(total).unwrap_or(100).min(100);
    format!("{name}  {} / {}  {percent}%", super::bytes(done), super::bytes(total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_names_the_kit_the_bytes_and_the_percent() {
        assert_eq!(line("note", 4_200_000, 11_000_000), "note  4.2 MB / 11.0 MB  38%");
        assert_eq!(line("note", 0, 0), "note  0 B / 0 B  100%");
    }
}
