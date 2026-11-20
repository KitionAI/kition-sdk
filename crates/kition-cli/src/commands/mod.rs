//! `kition`'s commands, one module each, and what they share: reading their arguments.

pub mod agent;
pub mod doctor;
pub mod gateway;
pub mod help;
pub mod kit;
pub mod progress;

use std::collections::BTreeMap;

/// A command's arguments: its words, and its options by name (`--json`, `--out`) with their
/// values.
#[derive(Debug, Default)]
pub struct Args {
    pub words: Vec<String>,
    options: BTreeMap<&'static str, Option<String>>,
}

impl Args {
    /// `args` read for a command whose options are `switches` (no value) and `valued`. Any other
    /// option is a mistake.
    pub fn parse(args: &[String], switches: &[&'static str], valued: &[&'static str]) -> Result<Self, String> {
        let mut parsed = Self::default();
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            let (name, inline) = match arg.split_once('=') {
                Some((name, value)) if arg.starts_with("--") => (name, Some(value.to_owned())),
                _ => (arg.as_str(), None),
            };
            if let Some(known) = valued.iter().find(|known| **known == name) {
                let value = match inline {
                    Some(value) => value,
                    None => args.next().cloned().ok_or_else(|| format!("{known} needs a value"))?,
                };
                if value.is_empty() {
                    return Err(format!("{known} needs a value"));
                }
                parsed.options.insert(known, Some(value));
            } else if let Some(known) = switches.iter().find(|known| **known == name).filter(|_| inline.is_none()) {
                parsed.options.insert(known, None);
            } else if arg.starts_with('-') && arg.len() > 1 {
                return Err(format!("unknown option {arg}"));
            } else {
                parsed.words.push(arg.clone());
            }
        }
        Ok(parsed)
    }

    /// Whether the switch `name` was given.
    pub fn has(&self, name: &str) -> bool {
        self.options.contains_key(name)
    }

    /// The value of the option `name`, when given.
    pub fn value(&self, name: &str) -> Option<&str> {
        self.options.get(name).and_then(|value| value.as_deref())
    }
}

/// Whether `args` ask for the usage.
pub fn asks_help(args: &[String]) -> bool {
    args.iter().any(|arg| matches!(arg.as_str(), "--help" | "-h"))
}

/// `text` as a shell would read it back: quoted when it holds anything but plain characters.
pub fn shell_quote(text: &str) -> String {
    if !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c)) {
        return text.to_owned();
    }
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// A count of bytes as people read it: `812 B`, `4.2 MB`.
pub fn bytes(count: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if count < 1000 {
        return format!("{count} B");
    }
    let mut value = count as f64 / 1000.0;
    let mut unit = 0;
    while value >= 1000.0 && unit + 1 < UNITS.len() {
        value /= 1000.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn options_are_read_with_or_without_equals() {
        let args = Args::parse(&strings(&["note", "--out", "x", "--json", "table", "--index=i"]), &["--json"], &["--out", "--index"]).unwrap();
        assert_eq!(args.words, ["note", "table"]);
        assert!(args.has("--json"));
        assert_eq!(args.value("--out"), Some("x"));
        assert_eq!(args.value("--index"), Some("i"));
        assert!(Args::parse(&strings(&["--frob"]), &[], &[]).unwrap_err().contains("unknown option --frob"));
        assert!(Args::parse(&strings(&["--out"]), &[], &["--out"]).unwrap_err().contains("needs a value"));
    }

    #[test]
    fn quoting_and_sizes() {
        assert_eq!(shell_quote("/a/b"), "/a/b");
        assert_eq!(shell_quote("/a b/it's"), "'/a b/it'\\''s'");
        assert_eq!(bytes(812), "812 B");
        assert_eq!(bytes(4_200_000), "4.2 MB");
    }
}
