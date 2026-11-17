//! A kit's file parameters (KHP A28, A29): the parameters of its commands that name files or
//! folders on disk, declared once in a table and written into the commands' schemas as typed
//! `file` parameters.
//!
//! Kit command notation (`{path?, format?}`) types a path as a plain string, and hosts never guess
//! a file from a parameter's name (requirement RFA1). So a kit lists its file parameters:
//!
//! ```ignore
//! const FILES: &[FileParam] = &[
//!     FileParam::read("file.open", "path", &["kvector", "svg"]),
//!     FileParam::write("document.save", "path", &[]),
//!     FileParam::create("document.export", "path", &[]),
//!     FileParam::folder("file.package", "folder"),
//! ];
//!
//! fn commands(&self) -> Vec<KitCommand> {
//!     let mut commands = self.engine_commands();
//!     kition_kit::files::declare(&mut commands, FILES);
//!     commands
//! }
//! ```
//!
//! A headless kit then keeps those commands off the agent's list and refuses them (the host opens,
//! saves and exports documents), and a host that lends files knows what each one is. The kit's
//! tests call [`check`], which fails on a table entry that names no parameter and on any
//! parameter called `path`, `file`, `folder` and the like that the kit has neither declared nor
//! listed as something else (a vector path's id, a property path): a lint for the kit's authors,
//! not a rule hosts apply.

use serde_json::{Map, Value, json};

use crate::KitCommand;

/// What a command does with a file it is given (KHP A28 `access`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// It reads the file (open, import, place, relink).
    Read,
    /// It writes the file, replacing it when it exists (save to the document's own file).
    Write,
    /// It writes a new file (save as, export, a copy).
    Create,
}

impl Access {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Create => "create",
        }
    }
}

/// One parameter of one command that names a file, or a folder (read only: KHP A28 has no folder
/// a command writes into, so a folder a command fills is declared as read too).
#[derive(Clone, Copy, Debug)]
pub struct FileParam {
    pub command: &'static str,
    pub param: &'static str,
    pub access: Access,
    /// Extensions without the dot; empty for any.
    pub accept: &'static [&'static str],
    pub folder: bool,
}

impl FileParam {
    #[must_use]
    pub const fn read(command: &'static str, param: &'static str, accept: &'static [&'static str]) -> Self {
        Self { command, param, access: Access::Read, accept, folder: false }
    }

    #[must_use]
    pub const fn write(command: &'static str, param: &'static str, accept: &'static [&'static str]) -> Self {
        Self { command, param, access: Access::Write, accept, folder: false }
    }

    #[must_use]
    pub const fn create(command: &'static str, param: &'static str, accept: &'static [&'static str]) -> Self {
        Self { command, param, access: Access::Create, accept, folder: false }
    }

    #[must_use]
    pub const fn folder(command: &'static str, param: &'static str) -> Self {
        Self { command, param, access: Access::Read, accept: &[], folder: true }
    }

    /// The `ParameterSchemaSpec` value node: a typed file (KHP A28), keeping a description.
    fn node(&self, description: Option<&Value>) -> Value {
        let mut node = Map::from_iter([("type".to_owned(), json!("file")), ("access".to_owned(), json!(self.access.as_str()))]);
        if self.folder {
            node.insert("kind".into(), json!("folder"));
        } else if !self.accept.is_empty() {
            node.insert("accept".into(), json!(self.accept));
        }
        if let Some(description) = description {
            node.insert("description".into(), description.clone());
        }
        Value::Object(node)
    }
}

/// Writes the table into the commands' schemas: each declared parameter becomes a typed file
/// (an array of them where the schema had an array). A command with no schema is left as it is: it
/// is off agents' lists already.
pub fn declare(commands: &mut [KitCommand], files: &[FileParam]) {
    for file in files {
        for command in commands.iter_mut().filter(|command| command.id == file.command) {
            let Some(Value::Object(properties)) = command.schema.as_mut() else { continue };
            let existing = properties.get(file.param);
            let description = existing.and_then(|node| node.get("description"));
            let required = existing.and_then(|node| node.get("required")).cloned();
            let array = existing.is_some_and(|node| node.get("type").and_then(Value::as_str) == Some("array"));
            let mut node = if array { json!({ "type": "array", "items": file.node(None) }) } else { file.node(description) };
            if let (Some(required), Some(object)) = (required, node.as_object_mut()) {
                object.insert("required".into(), required);
            }
            if array && let (Some(description), Some(object)) = (description, node.as_object_mut()) {
                object.insert("description".into(), description.clone());
            }
            properties.insert(file.param.to_owned(), node);
        }
    }
}

/// Parameter names that usually name files: [`check`] wants each one declared or explained.
const FILE_LIKE: &[&str] = &["path", "paths", "file", "files", "folder", "folders", "dir", "directory"];

/// The problems with a kit's table, after [`declare`]: entries that name no command or parameter,
/// and top-level parameters with a file-like name that are neither typed files nor in `not_files`
/// (`(command, param)` pairs the kit has looked at: a path that is an id, a property path).
#[must_use]
pub fn check(commands: &[KitCommand], files: &[FileParam], not_files: &[(&str, &str)]) -> Vec<String> {
    let mut problems = Vec::new();
    for file in files {
        let found = commands
            .iter()
            .filter(|command| command.id == file.command)
            .any(|command| command.schema.as_ref().and_then(|schema| schema.get(file.param)).is_some());
        if !found {
            problems.push(format!("{}: no parameter `{}` to declare", file.command, file.param));
        }
    }
    for (command, param) in not_files {
        if !commands.iter().any(|known| known.id == *command && known.schema.as_ref().and_then(|schema| schema.get(*param)).is_some()) {
            problems.push(format!("{command}: no parameter `{param}` to call not a file"));
        }
    }
    for command in commands {
        let Some(Value::Object(properties)) = &command.schema else { continue };
        for (name, node) in properties {
            let file_like = FILE_LIKE.iter().any(|like| like.eq_ignore_ascii_case(name));
            let explained = not_files.iter().any(|(id, param)| *id == command.id && param == name);
            if file_like && !explained && !crate::schema::names_file(node) {
                problems.push(format!("{}: `{name}` reads like a file; declare it (FileParam) or list it as not a file", command.id));
            }
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(id: &str, schema: Value) -> KitCommand {
        KitCommand { id: id.into(), title: id.into(), schema: Some(schema), enabled: true, ..KitCommand::default() }
    }

    #[test]
    fn declared_parameters_become_typed_files_that_validate() {
        let mut commands = vec![
            command("file.open", json!({ "path": { "type": "string", "required": true, "description": "the file" } })),
            command("file.import", json!({ "paths": { "type": "array", "items": { "type": "string" } } })),
            command("file.package", json!({ "folder": { "type": "string" } })),
            command("path.reverse", json!({ "path": { "type": "integer" } })),
        ];
        let files =
            [FileParam::read("file.open", "path", &["kvector"]), FileParam::read("file.import", "paths", &[]), FileParam::folder("file.package", "folder")];
        declare(&mut commands, &files);
        for command in &commands[..3] {
            let schema = command.schema.as_ref().map_or_else(Map::new, |schema| schema.as_object().cloned().unwrap_or_default());
            crate::schema::validate(&Value::Object(schema.clone())).unwrap_or_else(|error| panic!("{}: {error}", command.id));
            assert_eq!(crate::schema::file_params(&Value::Object(schema)).len(), 1, "{}", command.id);
        }
        assert_eq!(
            commands[0].schema,
            Some(json!({ "path": { "type": "file", "access": "read", "accept": ["kvector"], "description": "the file", "required": true } }))
        );
        assert!(check(&commands, &files, &[("path.reverse", "path")]).is_empty());
    }

    #[test]
    fn check_finds_undeclared_files_and_stale_entries() {
        let commands = vec![command("document.save", json!({ "path": { "type": "string" } }))];
        let problems = check(&commands, &[FileParam::create("document.export", "path", &[])], &[("text.create", "path")]);
        assert_eq!(problems.len(), 3, "{problems:#?}");
    }
}
