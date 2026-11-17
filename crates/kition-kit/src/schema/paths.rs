//! Parameters that look like they carry a path in a plain string (KHP A28): what
//! [`crate::testing::check_file_parameters`] flags.

use serde_json::Value;

use super::names_file;

/// Words of a parameter's name that say it names a file, a folder, or a URL.
pub const PATH_NAME_WORDS: &[&str] = &[
    "path",
    "paths",
    "file",
    "files",
    "filename",
    "filenames",
    "folder",
    "folders",
    "dir",
    "dirs",
    "directory",
    "location",
    "destination",
    "dest",
    "source",
    "src",
    "url",
    "urls",
    "uri",
    "uris",
    "output",
    "input",
];

/// Phrases of a parameter's description that say its value names a file, a folder, or a URL.
pub const PATH_DESCRIPTION_PHRASES: &[&str] = &[
    "file path",
    "path to",
    "path of the file",
    "pdf path",
    "name|path",
    "this file",
    "folder",
    "directory",
    "url",
    "uri",
    "file name",
    "filename",
    "on disk",
    "file system",
    "filesystem",
];

/// A string parameter that may carry a path: its name (`a.b` inside objects, `a[]` for items) and
/// why it was flagged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathLike {
    pub param: String,
    pub why: String,
}

/// The words of a parameter name: `outputDir` is `output`, `dir`; `file_name` is `file`, `name`.
fn name_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut previous_lower = false;
    for c in name.chars() {
        if !c.is_ascii_alphanumeric() {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            previous_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && previous_lower && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        previous_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        word.push(c.to_ascii_lowercase());
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// Whether `text` holds `phrase` between word boundaries.
fn has_phrase(text: &str, phrase: &str) -> bool {
    let boundary = |c: Option<char>| c.is_none_or(|c| !c.is_ascii_alphanumeric());
    text.match_indices(phrase).any(|(at, _)| {
        boundary(text.get(..at).and_then(|before| before.chars().last())) && boundary(text.get(at + phrase.len()..).and_then(|after| after.chars().next()))
    })
}

/// Whether a value node takes free text: a `string` without `enum` or `const`, or a `oneOf` with
/// such a branch.
fn free_string(node: &Value) -> bool {
    let Some(object) = node.as_object() else { return false };
    if let Some(branches) = object.get("oneOf").and_then(Value::as_array) {
        return branches.iter().any(free_string);
    }
    object.get("type").and_then(Value::as_str) == Some("string") && !object.contains_key("enum") && !object.contains_key("const")
}

/// Why `name` with `node` looks like a path in a plain string, if it does.
fn looks_like_path(name: &str, node: &Value) -> Option<String> {
    if !free_string(node) || node.get("notFile") == Some(&Value::Bool(true)) || names_file(node) {
        return None;
    }
    if let Some(word) = name_words(name).into_iter().find(|word| PATH_NAME_WORDS.contains(&word.as_str())) {
        return Some(format!("its name says `{word}`"));
    }
    let description = node.get("description").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    PATH_DESCRIPTION_PHRASES.iter().find(|phrase| has_phrase(&description, phrase)).map(|phrase| format!("its description says `{phrase}`"))
}

fn visit(name: &str, node: &Value, out: &mut Vec<PathLike>) {
    if let Some(why) = looks_like_path(name.rsplit(['.', '[']).next().unwrap_or(name), node) {
        out.push(PathLike { param: name.to_owned(), why });
    }
    if let Some(items) = node.get("items") {
        let leaf = name.rsplit('.').next().unwrap_or(name);
        if let Some(why) = looks_like_path(leaf, items) {
            out.push(PathLike { param: format!("{name}[]"), why });
        }
        if let Some(properties) = items.get("properties").and_then(Value::as_object) {
            for (key, inner) in properties {
                visit(&format!("{name}[].{key}"), inner, out);
            }
        }
    }
    if let Some(properties) = node.get("properties").and_then(Value::as_object) {
        for (key, inner) in properties {
            visit(&format!("{name}.{key}"), inner, out);
        }
    }
}

/// The plain string parameters of a `ParameterSchemaSpec` whose name or description says they
/// name a file, a folder, or a URL (KHP A28: such a parameter is typed `file`, or the command is
/// not offered to agents), at any depth. A parameter marked `notFile: true` was reviewed and
/// carries no path; an `enum` or `const` string carries none either.
#[must_use]
pub fn path_like_parameters(schema: &Value) -> Vec<PathLike> {
    let mut out = Vec::new();
    for (name, node) in schema.as_object().into_iter().flatten() {
        visit(name, node, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_and_descriptions_that_say_path_are_flagged_and_reviewed_ones_are_not() {
        let schema = json!({
            "destination": { "type": "string" },
            "outputDir": { "type": "string" },
            "image": { "type": "string", "description": "The image file name to place." },
            "text": { "type": "string", "description": "The text to type." },
            "profile": { "type": "string" },
            "mode": { "type": "string", "enum": ["path", "file"] },
            "to": { "type": "file", "access": "create" },
            "source": { "type": "string", "notFile": true, "description": "The HTML source." },
            "steps": { "type": "array", "items": { "type": "object", "additionalProperties": false, "properties": { "url": { "type": "string" } } } },
            "paths": { "type": "array", "items": { "type": "string" } },
        });
        let mut found: Vec<String> = path_like_parameters(&schema).into_iter().map(|path| format!("{}: {}", path.param, path.why)).collect();
        found.sort();
        assert_eq!(
            found,
            [
                "destination: its name says `destination`",
                "image: its description says `file name`",
                "outputDir: its name says `output`",
                "paths[]: its name says `paths`",
                "steps[].url: its name says `url`",
            ]
        );
        assert_eq!(name_words("file_name"), ["file", "name"]);
        assert_eq!(name_words("recoveryFolderURL"), ["recovery", "folder", "url"]);
    }
}
