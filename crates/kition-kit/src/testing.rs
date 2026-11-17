//! Contract checks a kit runs from its own tests:
//!
//! ```ignore
//! #[test]
//! fn keeps_the_kit_contract() {
//!     kition_kit::testing::check_contract::<SketchDocument>(&fixture_bytes(), "fixture.sketch", |doc| {
//!         doc.execute("draw.line", serde_json::json!({ "from": [1, 1], "to": [20, 10] })).map(|_| ())
//!     })
//!.unwrap();
//! }
//! ```

use crate::KitDocument;
use crate::outputs::OutputInfo;

mod nested;
pub use nested::{Dispatcher, check_nested_dispatch_is_gated, step_list};

/// Checks what Kition relies on, with a real file and one edit that changes pixels:
///
/// - the document opens, has a size, and bad bytes are an error rather than a panic;
/// - `render` and `render_area` return exactly `width × height × 4` bytes;
/// - `render_area` at a whole-number reduction is the exact box mean of the 1:1 pixels;
/// - the edit moves `revision`, sets `dirty`, and changes the render;
/// - `inspect` has `canUndo` and `canRedo`, and the commands include `edit.undo` and `edit.redo`;
/// - `disabled_commands` names exactly the commands `commands` reports disabled, before and after
///   the edit;
/// - unknown commands are errors, and so is taking an output the document never made;
/// - `save` leaves the document dirty until `mark_saved`, and its bytes reopen to the same pixels.
pub fn check_contract<D: KitDocument>(fixture: &[u8], name: &str, edit: impl FnOnce(&mut D) -> Result<(), String>) -> Result<(), String> {
    if D::open(name, b"not a document").is_ok() {
        return Err("open accepted bytes that are not a document".into());
    }
    let mut doc = D::open(name, fixture)?;
    let (w, h) = (doc.width(), doc.height());
    if w == 0 || h == 0 {
        return Err(format!("the fixture opened with size {w} x {h}"));
    }
    let full = doc.render(0.0, 0.0, 1.0, w, h)?;
    expect_len(&full, w, h, "render")?;
    check_box_mean(&doc, &full)?;

    let inspected = doc.inspect()?;
    for key in ["canUndo", "canRedo"] {
        if inspected.get(key).and_then(serde_json::Value::as_bool).is_none() {
            return Err(format!("inspect has no boolean `{key}`"));
        }
    }
    let commands = doc.commands();
    for command in &commands {
        if let Some(output) = &command.output_schema {
            crate::schema::validate_output(output).map_err(|error| format!("`{}`'s output schema: {error}", command.id))?;
        }
    }
    for id in ["edit.undo", "edit.redo"] {
        if !commands.iter().any(|command| command.id == id) {
            return Err(format!("the commands do not include `{id}`"));
        }
    }
    check_disabled(&doc, "before the edit")?;
    check_check(&doc, "before the edit")?;
    if doc.execute("kition.no-such-command", serde_json::json!({})).is_ok() {
        return Err("an unknown command did not fail".into());
    }
    if doc.take_output("kition.no-such-output", None).is_ok() {
        return Err("take_output answered an output the document never made".into());
    }

    let before = doc.revision();
    edit(&mut doc)?;
    if doc.revision() == before {
        return Err("the edit did not move revision".into());
    }
    if !doc.dirty() {
        return Err("the edit did not make the document dirty".into());
    }
    check_disabled(&doc, "after the edit")?;
    check_check(&doc, "after the edit")?;
    let edited = doc.render(0.0, 0.0, 1.0, doc.width(), doc.height())?;
    if edited == full {
        return Err("the edit did not change the render".into());
    }

    let bytes = doc.save(None)?;
    if !doc.dirty() {
        return Err("save marked the document saved; only mark_saved may".into());
    }
    doc.mark_saved();
    if doc.dirty() {
        return Err("mark_saved left the document dirty".into());
    }
    let reopened = D::open(name, &bytes)?;
    if reopened.render(0.0, 0.0, 1.0, reopened.width(), reopened.height())? != edited {
        return Err("the saved bytes reopened to different pixels".into());
    }
    Ok(())
}

/// Runs `command`, which produces files (engine contract E16), and checks its outputs as a host takes them:
///
/// - it answers `outputs`, each with an id, a suggested name with an extension, a MIME type, and
///   a size;
/// - each output comes out in small chunks to exactly its size, and taking it again is an error
///   (the engine forgets it);
/// - producing outputs does not change the document (neither revision nor dirty state).
///
/// Answers each output's info and bytes, for the kit's own checks of the contents.
pub fn check_outputs<D: KitDocument>(doc: &mut D, command: &str, params: serde_json::Value) -> Result<Vec<(OutputInfo, Vec<u8>)>, String> {
    let (revision, dirty) = (doc.revision(), doc.dirty());
    let answer = doc.execute(command, params)?;
    let listed = answer.get("outputs").cloned().ok_or_else(|| format!("`{command}` answered no `outputs`"))?;
    let infos: Vec<OutputInfo> = serde_json::from_value(listed).map_err(|error| format!("`{command}`'s outputs: {error}"))?;
    if infos.is_empty() {
        return Err(format!("`{command}` answered no outputs"));
    }
    let mut taken = Vec::new();
    for info in infos {
        if info.id.is_empty() || info.mime.is_empty() || !info.suggested_name.contains('.') {
            return Err(format!("`{command}`'s output {info:?} lacks an id, a MIME type, or a name with an extension"));
        }
        let mut bytes = Vec::new();
        // Small chunks, as a host takes a long output; an output of any size ends in a few steps.
        let chunk = usize::try_from(info.size / 3).unwrap_or(usize::MAX).max(1);
        while bytes.len() < usize::try_from(info.size).unwrap_or(usize::MAX) {
            let next = doc.take_output(&info.id, Some(chunk))?;
            if next.is_empty() || next.len() > chunk {
                return Err(format!("output {} came out in a chunk of {} bytes when {chunk} were asked", info.id, next.len()));
            }
            bytes.extend(next);
        }
        if info.size == 0 {
            doc.take_output(&info.id, Some(chunk))?;
        }
        if bytes.len() as u64 != info.size {
            return Err(format!("output {} gave {} bytes; it said {}", info.id, bytes.len(), info.size));
        }
        if doc.take_output(&info.id, None).is_ok() {
            return Err(format!("output {} could be taken again: the engine must forget a taken output", info.id));
        }
        taken.push((info, bytes));
    }
    if doc.revision() != revision || doc.dirty() != dirty {
        return Err(format!("`{command}` changed the document while producing outputs"));
    }
    Ok(taken)
}

/// `check` answers well-formed diagnostics and leaves the document as it was.
fn check_check<D: KitDocument>(doc: &D, when: &str) -> Result<(), String> {
    let (revision, dirty) = (doc.revision(), doc.dirty());
    crate::diagnostics::check_diagnostics(&doc.check()).map_err(|error| format!("check {when}: {error}"))?;
    if doc.revision() != revision || doc.dirty() != dirty {
        return Err(format!("check {when} changed the document"));
    }
    Ok(())
}

/// Checks [`KitDocument::text`] (`KitText 1.0`, `document.text`) on an open document, for a kit
/// that lists the capability `document-text`, and answers the full text so the kit's test can
/// compare it with what the fixture says:
///
/// - with the default limit, the text has at most that many Unicode scalar values, and every
///   part has a label and a range inside the text, in order, not overlapping (T3, T4);
/// - asking twice answers the same, and nothing changes: revision, dirty state, and `inspect`
///   (T2);
/// - with its own length as the limit the answer is whole; with less (that length minus one, half
///   of it, one, zero) it is the start of the whole text, `truncated`, and within the limit (T5).
pub fn check_text<D: KitDocument>(doc: &D) -> Result<crate::text::DocumentText, String> {
    use crate::text::DEFAULT_LIMIT;
    let (revision, dirty, inspected) = (doc.revision(), doc.dirty(), doc.inspect()?);
    let full = doc.text(DEFAULT_LIMIT)?;
    check_text_answer(&full, DEFAULT_LIMIT)?;
    if doc.text(DEFAULT_LIMIT)? != full {
        return Err("text answered differently the second time".into());
    }
    let length = full.text.chars().count();
    if !full.truncated {
        let whole = doc.text(length)?;
        if whole != full {
            return Err(format!("text with its own length ({length}) as the limit is not the whole text"));
        }
    }
    let mut limits = vec![length.saturating_sub(1), length / 2, 1, 0];
    limits.retain(|limit| *limit < length);
    limits.dedup();
    for limit in limits {
        let cut = doc.text(limit)?;
        check_text_answer(&cut, limit)?;
        if !cut.truncated {
            return Err(format!("text with limit {limit} of {length} is not truncated"));
        }
        if !full.text.starts_with(&cut.text) {
            return Err(format!("text with limit {limit} is not the start of the whole text"));
        }
    }
    if doc.revision() != revision || doc.dirty() != dirty || doc.inspect()? != inspected {
        return Err("text changed the document".into());
    }
    Ok(full)
}

/// One `document.text` answer is within its limit and its parts within its text.
pub fn check_text_answer(answer: &crate::text::DocumentText, limit: usize) -> Result<(), String> {
    let length = answer.text.chars().count();
    if length > limit {
        return Err(format!("text has {length} characters over the limit {limit}"));
    }
    let mut after = 0;
    for part in &answer.parts {
        if part.label.trim().is_empty() {
            return Err("a text part has no label".into());
        }
        if part.start < after || part.start > part.end || part.end > length {
            return Err(format!("the part `{}` ({}..{}) is outside the text ({length}) or overlaps the one before", part.label, part.start, part.end));
        }
        after = part.end;
    }
    Ok(())
}

/// The light enabled-state call must agree with the full command list.
fn check_disabled<D: KitDocument>(doc: &D, when: &str) -> Result<(), String> {
    let mut expected: Vec<String> = doc.commands().into_iter().filter(|command| !command.enabled).map(|command| command.id).collect();
    let mut answered = doc.disabled_commands();
    expected.sort_unstable();
    answered.sort_unstable();
    if expected == answered {
        return Ok(());
    }
    let missing: Vec<&String> = expected.iter().filter(|id| !answered.contains(id)).take(5).collect();
    let extra: Vec<&String> = answered.iter().filter(|id| !expected.contains(id)).take(5).collect();
    Err(format!("disabled_commands disagrees with commands {when}: missing {missing:?}, extra {extra:?}"))
}

fn expect_len(rgba: &[u8], width: u32, height: u32, what: &str) -> Result<(), String> {
    let wanted = width as usize * height as usize * 4;
    if rgba.len() == wanted { Ok(()) } else { Err(format!("{what} returned {} bytes for {width} x {height}; expected {wanted}", rgba.len())) }
}

/// A 2:1 reduction of the top-left area must be the rounded mean of each 2 × 2 block.
fn check_box_mean<D: KitDocument>(doc: &D, full: &[u8]) -> Result<(), String> {
    let (w, h) = (doc.width(), doc.height());
    let (ow, oh) = ((w / 2).min(16), (h / 2).min(16));
    if ow == 0 || oh == 0 {
        return Ok(());
    }
    let reduced = doc.render_area(0, 0, (ow * 2) as i32, (oh * 2) as i32, ow, oh)?;
    expect_len(&reduced, ow, oh, "render_area")?;
    for y in 0..oh as usize {
        for x in 0..ow as usize {
            for channel in 0..4 {
                let at = |px: usize, py: usize| f64::from(full.get((py * w as usize + px) * 4 + channel).copied().unwrap_or(0));
                let mean = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4.0;
                let got = f64::from(reduced.get((y * ow as usize + x) * 4 + channel).copied().unwrap_or(0));
                // Premultiplied averaging can move straight-alpha colour where alpha varies; allow 2 levels.
                if (got - mean).abs() > 2.5 {
                    return Err(format!("render_area at 1/2 is not the box mean at ({x}, {y}) channel {channel}: {got} vs {mean}"));
                }
            }
        }
    }
    Ok(())
}

/// Fewer words than this and a description says no more than a title.
const MIN_DESCRIPTION_WORDS: usize = 4;

/// Checks that every command tells people and agents what it is for, so a model picks a command
/// by what it does rather than by its title (KitCommand::description, KHP A1):
///
/// - every command has a description of at least four words that is not its title again (case and
///   punctuation aside) and not parameter notation (`Params: …`);
/// - every command an agent is offered (it has a parameter schema) that only reads (`mutates` is
///   false) declares `output_schema`, so hosts can tell the model what it answers — unless the kit
///   lists it in `no_output` with the reason it answers nothing (`("view.zoomIn", "moves the view
///   only")`);
/// - every `no_output` entry names an offered read command that has no output schema, and gives a
///   reason, so the list cannot go stale;
/// - a command's `targets` names one of its parameters that is an id or a list of ids
///   ([`crate::schema::check_targets`]).
///
/// Returns every problem, one line each. A kit runs it from its own tests:
///
/// ```ignore
/// #[test]
/// fn every_command_says_what_it_does() {
///     let doc = SketchDocument::create("a.sketch", 64, 64).unwrap();
///     kition_kit::testing::check_commands(&doc.commands(), NO_OUTPUT).unwrap();
/// }
/// ```
pub fn check_commands(commands: &[crate::KitCommand], no_output: &[(&str, &str)]) -> Result<(), Vec<String>> {
    let plain = |text: &str| text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
    let mut problems = Vec::new();
    for command in commands {
        let description = command.description.trim();
        if description.is_empty() {
            problems.push(format!("{}: no description", command.id));
        } else if description.starts_with("Params:") {
            problems.push(format!("{}: the description is parameter notation, not what the command does", command.id));
        } else if plain(description) == plain(&command.title) {
            problems.push(format!("{}: the description only repeats the title", command.id));
        } else if description.split_whitespace().count() < MIN_DESCRIPTION_WORDS {
            problems.push(format!("{}: the description `{description}` is too short to say what the command does", command.id));
        }
        if let Some(name) = command.targets {
            match &command.schema {
                Some(schema) => {
                    if let Err(problem) = crate::schema::check_targets(schema, name) {
                        problems.push(format!("{}: {problem}", command.id));
                    }
                }
                None => problems.push(format!("{}: targets names `{name}`, and the command has no schema", command.id)),
            }
        }
        let offered_read = command.schema.is_some() && !command.mutates;
        if offered_read && command.output_schema.is_none() && !no_output.iter().any(|(id, _)| *id == command.id) {
            problems.push(format!(
                "{}: a read command an agent is offered declares no output_schema (or list it in no_output with why it answers nothing)",
                command.id
            ));
        }
    }
    for (id, reason) in no_output {
        match commands.iter().find(|command| command.id == *id) {
            None => problems.push(format!("no_output names {id}, which is not a command")),
            Some(command) if command.schema.is_none() || command.mutates => {
                problems.push(format!("no_output names {id}, which is not a read command an agent is offered"));
            }
            Some(command) if command.output_schema.is_some() => problems.push(format!("no_output names {id}, which declares an output_schema")),
            Some(_) if reason.trim().is_empty() => problems.push(format!("no_output gives no reason for {id}")),
            Some(_) => {}
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

/// Checks the editor-state hooks ([`KitDocument::editor_state`], [`KitDocument::set_context`],
/// [`KitDocument::restore_editor_state`]) with one `context` the document has (ids it lists, a part
/// it has), best one that moves the editor (another part, another selection): setting it and
/// restoring the state saved before change nothing in the document, and the state after the
/// restore is the state before.
///
/// "Nothing in the document" is its `revision`, its dirty state, its undo history (`canUndo` and
/// `canRedo` in `inspect`), and its content: what `inspect` answers without the editor state the
/// kit declares (`editor_state`, the same keys and JSON Pointers it gives kition-headless as its
/// volatile keys; [`crate::document_content`]). A kit's `inspect` may report its current part,
/// selection or playhead for its own editor; those move with the context and are not compared, so
/// an `editor_state` list that misses one is named as a change of the content. A kit runs it from
/// its tests once it implements the hooks:
///
/// ```ignore
/// let mut doc = SlideDocument::open("deck.kslide", &fixture()).unwrap();
/// let on = kition_kit::CallContext { on: vec![json!("s2")], part: Some(json!({ "slide": 2 })), time: None };
/// kition_kit::testing::check_context(&mut doc, &on, kition_slide_kit::EDITOR_STATE).unwrap();
/// ```
pub fn check_context<D: KitDocument>(doc: &mut D, context: &crate::CallContext, editor_state: &[&str]) -> Result<(), String> {
    let history = |inspected: &serde_json::Value| (inspected.get("canUndo").cloned(), inspected.get("canRedo").cloned());
    let inspected = doc.inspect()?;
    let (revision, dirty, undo, saved) = (doc.revision(), doc.dirty(), history(&inspected), doc.editor_state());
    let content = crate::document_content(inspected, editor_state);
    let unchanged = |doc: &D, after: &str| -> Result<(), String> {
        if doc.revision() != revision || doc.dirty() != dirty {
            return Err(format!("{after} changed the document: revision {revision} -> {}, dirty {dirty} -> {}", doc.revision(), doc.dirty()));
        }
        let inspected = doc.inspect()?;
        if history(&inspected) != undo {
            return Err(format!("{after} changed the undo history: canUndo, canRedo {undo:?} -> {:?}", history(&inspected)));
        }
        let now = crate::document_content(inspected, editor_state);
        if now != content {
            return Err(format!(
                "{after} changed the document's content: what inspect answers without the declared editor state {editor_state:?} went from {content} to {now} (a key that is editor state belongs in the kit's editor-state list)"
            ));
        }
        Ok(())
    };
    doc.set_context(context).map_err(|error| format!("set_context refused a context the document has: {error}"))?;
    unchanged(doc, "set_context")?;
    doc.restore_editor_state(&saved).map_err(|error| format!("restore_editor_state refused what editor_state answered: {error}"))?;
    unchanged(doc, "restore_editor_state")?;
    if doc.editor_state() != saved {
        return Err(format!("after restore_editor_state the editor state is {}, not {saved}", doc.editor_state()));
    }
    Ok(())
}

/// Proves a kit's opt-in to published required parameters ([`crate::KitCommand::notation_required`])
/// on a fixture, for each opted-in command `checked` selects, so a kit turns the switch on safely,
/// command by command. `calls` gives, for each such command, one call with exactly its required
/// parameters (those its schema marks `required`), with values valid on the document `fresh`
/// opens. On a fresh document each time, straight to the engine (no host's gate in between):
///
/// - the call runs: a command that fails with only its required parameters needs one its notation
///   marks optional or defaulted (the published schema is too loose; or the call's values are
///   wrong for the fixture);
/// - the call without each required parameter fails: a command that runs without one does not
///   need it, and publishing it required would make that valid call impossible (too strict);
/// - every selected opted-in command has a call, and every call names an opted-in command.
///
/// A panic is a problem too. Returns every problem, one line each:
///
/// ```ignore
/// #[test]
/// fn the_required_parameters_are_right() {
///     let calls = [("layer.rename", json!({ "layer": 2, "name": "Ink" }))];
///     kition_kit::testing::check_required(|| fixture_document(), &calls, |_| true).unwrap();
/// }
/// ```
pub fn check_required<D: KitDocument>(
    mut fresh: impl FnMut() -> D,
    calls: &[(&str, serde_json::Value)],
    checked: impl Fn(&str) -> bool,
) -> Result<(), Vec<String>> {
    let commands = fresh().commands();
    let required_of = |schema: &serde_json::Value| -> Vec<String> {
        schema
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, node)| node.get("required") == Some(&serde_json::Value::Bool(true)))
            .map(|(key, _)| key.clone())
            .collect()
    };
    let mut problems = Vec::new();
    for (id, _) in calls {
        match commands.iter().find(|command| command.id == *id) {
            None => problems.push(format!("calls name {id}, which is not a command")),
            Some(command) if !command.notation_required => problems.push(format!("{id}: a call is given, but the command is not opted in (notation_required)")),
            Some(_) => {}
        }
    }
    let run =
        |doc: &mut D, id: &str, params: serde_json::Value| std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| doc.execute(id, params))).map_err(|_| ());
    for command in commands.iter().filter(|command| command.notation_required && checked(&command.id)) {
        let id = command.id.as_str();
        let Some(schema) = &command.schema else {
            problems.push(format!("{id}: opted in, but it has no parameter schema (call with_kit_schema)"));
            continue;
        };
        let Some((_, call)) = calls.iter().find(|(called, _)| *called == id) else {
            problems.push(format!("{id}: opted in, but no call is given to prove its required parameters"));
            continue;
        };
        let required = required_of(schema);
        let mut given: Vec<String> = call.as_object().map(|call| call.keys().cloned().collect()).unwrap_or_default();
        let mut wanted = required.clone();
        given.sort();
        wanted.sort();
        if given != wanted {
            let named =
                |keys: &[String]| if keys.is_empty() { "none".to_owned() } else { keys.iter().map(|key| format!("`{key}`")).collect::<Vec<_>>().join(", ") };
            problems.push(format!("{id}: the call gives {}; it must give exactly its required parameters, {}", named(&given), named(&wanted)));
            continue;
        }
        match run(&mut fresh(), id, call.clone()) {
            Err(()) => problems.push(format!("{id}: panicked with only its required parameters")),
            Ok(Err(message)) => problems.push(format!(
                "{id}: fails with only its required parameters ({message}): it needs a parameter its notation marks optional or defaulted, or the call's values do not fit the fixture"
            )),
            Ok(Ok(_)) => {}
        }
        for key in &required {
            let mut without = call.clone();
            if let Some(fields) = without.as_object_mut() {
                fields.remove(key);
            }
            match run(&mut fresh(), id, without) {
                Err(()) => problems.push(format!("{id}: panicked without `{key}`")),
                Ok(Ok(_)) => problems.push(format!(
                    "{id}: `{key}` is published required, but the command runs without it: mark it optional (`?`) or give its default in the notation"
                )),
                Ok(Err(_)) => {}
            }
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

/// Checks that no command an agent is offered smuggles a path in a plain string (KHP A28: a
/// parameter that names a file is typed `file`; a command whose parameters name files otherwise is
/// not offered to agents). A command is offered when it has a parameter schema, no `file`
/// parameter (or the kit lists it in `sandboxed`, as it does for kition-headless), and the
/// manifest's `agent.include` and `agent.exclude` keep it. Each of its free-text string
/// parameters, at any depth, whose name says `path`, `file`, `folder`, `dir`, `location`,
/// `destination`, `source`, `src`, `url`, `uri`, `output` or `input` (a word of the name:
/// `outputDir`, `file_name`), or whose description says `file path`, `folder`, `directory`,
/// `url`, `file name`, `on disk` and the like ([`crate::schema::path_like_parameters`]), is a
/// problem until the kit types it `file` or marks it `"notFile": true`, the record that someone
/// reviewed it and it carries no path (a property path inside the document, HTML source, a font
/// family). An `enum` string is never flagged.
///
/// It reads names and descriptions, not values: a generic setter (`prefs.set { key, value }`)
/// that stores a folder under a key is not found, and a reviewed `notFile` is trusted.
///
/// ```ignore
/// #[test]
/// fn no_command_takes_a_path_in_a_plain_string() {
///     let doc = SketchDocument::create("a.sketch", 64, 64).unwrap();
///     kition_kit::testing::check_file_parameters(&doc.commands(), include_str!("../../../kit.json"), SANDBOXED).unwrap();
/// }
/// ```
pub fn check_file_parameters(commands: &[crate::KitCommand], manifest: &str, sandboxed: &[&str]) -> Result<(), Vec<String>> {
    let manifest: serde_json::Value = serde_json::from_str(manifest).map_err(|error| vec![format!("kit.json is not JSON: {error}")])?;
    let patterns = |key: &str| -> Option<Vec<String>> {
        manifest["agent"][key].as_array().map(|list| list.iter().filter_map(|pattern| pattern.as_str().map(str::to_owned)).collect())
    };
    let (include, exclude) = (patterns("include"), patterns("exclude").unwrap_or_default());
    let named = |patterns: &[String], id: &str| patterns.iter().any(|pattern| crate::dispatch::pattern_matches(pattern, id));
    let mut problems = Vec::new();
    for command in commands {
        let Some(schema) = &command.schema else { continue };
        let offered = (sandboxed.contains(&command.id.as_str()) || crate::schema::file_params(schema).is_empty())
            && include.as_deref().is_none_or(|include| named(include, &command.id))
            && !named(&exclude, &command.id);
        if !offered {
            continue;
        }
        for found in crate::schema::path_like_parameters(schema) {
            problems.push(format!(
                "{}: `{}` is a plain string, but {}: type it `file` (KHP A28), or mark it \"notFile\": true once reviewed",
                command.id, found.param, found.why
            ));
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

/// Checks that every parameter that takes integer ids is marked as naming objects: since a whole number is an object's id, a premise of an agent's write with
/// `basis`, only in the target parameter ([`KitCommand::targets`](crate::KitCommand::targets)) or
/// one listed in [`KitCommand::objects`](crate::KitCommand::objects); in any other it is a count
/// and holds nothing, so a kit that forgets to mark `parent: 3` has its writes applied over a
/// colleague's change of object 3, silently.
///
/// A parameter takes integer ids when its schema takes an integer (alone, in a `oneOf`, or as a
/// list's items) and its name or its description says it is an id: the name is `id` or `ids` or
/// ends with `Id`, `Ids`, `_id` or `_ids`, or the description has the word `id` or `ids`.
/// It is fine when it is the targets, an object parameter, a place
/// ([`KitCommand::places`](crate::KitCommand::places)), or listed in `allow` as
/// `(command, parameter)` (an id the command reads as no object of the document: a frame id, an
/// id in another file). Returns every problem, one line each. A kit runs it from its own tests:
///
/// ```ignore
/// #[test]
/// fn every_id_parameter_is_marked() {
///     let doc = FilmDocument::create("a.kfilm").unwrap();
///     kition_kit::testing::check_id_params(&doc.commands(), &[("export.frame", "frameId")]).unwrap();
/// }
/// ```
pub fn check_id_params(commands: &[crate::KitCommand], allow: &[(&str, &str)]) -> Result<(), Vec<String>> {
    fn integer(node: &serde_json::Value) -> bool {
        match node.get("oneOf").and_then(serde_json::Value::as_array) {
            Some(branches) => branches.iter().any(integer),
            None => match node.get("type").and_then(serde_json::Value::as_str) {
                Some("integer") => true,
                Some("array") => node.get("items").is_some_and(integer),
                _ => false,
            },
        }
    }
    let says_id = |name: &str, node: &serde_json::Value| {
        let named = matches!(name, "id" | "ids") || ["Id", "Ids", "_id", "_ids"].iter().any(|end| name.ends_with(end));
        let described = node
            .get("description")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|text| text.split(|c: char| !c.is_alphanumeric()).any(|word| word.eq_ignore_ascii_case("id") || word.eq_ignore_ascii_case("ids")));
        named || described
    };
    let mut problems = Vec::new();
    for command in commands {
        let command = command.clone().with_kit_schema();
        let Some(properties) = command.schema.as_ref().and_then(serde_json::Value::as_object) else { continue };
        for (name, node) in properties {
            if !integer(node) || !says_id(name, node) {
                continue;
            }
            let marked = command.targets == Some(name.as_str())
                || command.objects.contains(&name.as_str())
                || command.places.contains(&name.as_str())
                || allow.contains(&(command.id.as_str(), name.as_str()));
            if !marked {
                problems.push(format!(
                    "{}: `{name}` takes integer ids but is neither its `targets`, in `objects` nor a place: a whole number there names no object for the premise guard; add it to `KitCommand::objects` (with `object_types` when it names one type), or list it in the allow-list with why",
                    command.id
                ));
            }
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

/// The key [`check_unknown_params`] adds; no schema names it.
pub const UNKNOWN_PARAM: &str = "zzUnknownParam";

/// Calls every command that has a parameter schema once, each on a fresh document from `fresh`,
/// with one key its schema does not name ([`UNKNOWN_PARAM`]), and checks that the call is refused
/// with an error that names the key. An agent that misspells a parameter (`objects` for
/// `object`) must be told, not have the command run on a guess.
///
/// `open` lists the commands whose top level takes keys the schema cannot name (a map of setting
/// names, say), each with why; they are skipped, as are commands that say so themselves
/// ([`KitCommand::open_params`](crate::KitCommand::open_params)). A command that accepts the key, refuses it
/// without naming it (often because a required key is missing first), or panics is a problem.
pub fn check_unknown_params<D: KitDocument>(mut fresh: impl FnMut() -> D, open: &[(&str, &str)]) -> Result<(), Vec<String>> {
    let commands = fresh().commands();
    let mut problems = Vec::new();
    for (id, reason) in open {
        match commands.iter().find(|command| command.id == *id) {
            None => problems.push(format!("open names {id}, which is not a command")),
            Some(command) if command.schema.is_none() => problems.push(format!("open names {id}, which has no parameter schema")),
            Some(_) if reason.trim().is_empty() => problems.push(format!("open gives no reason for {id}")),
            Some(_) => {}
        }
    }
    for command in commands.iter().filter(|command| command.schema.is_some()) {
        if command.open_params || open.iter().any(|(id, _)| *id == command.id) {
            continue;
        }
        let mut doc = fresh();
        let params = serde_json::json!({ UNKNOWN_PARAM: 1 });
        let answer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| doc.execute(&command.id, params)));
        match answer {
            Err(_) => problems.push(format!("{}: panicked on an unknown parameter", command.id)),
            Ok(Ok(_)) => problems.push(format!("{}: accepted the unknown parameter `{UNKNOWN_PARAM}`", command.id)),
            Ok(Err(message)) if !message.contains(UNKNOWN_PARAM) => {
                problems.push(format!("{}: refused, but the error does not name `{UNKNOWN_PARAM}`: {message}", command.id));
            }
            Ok(Err(_)) => {}
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

/// Damaged copies of a valid file, each with a short label, the same on every run: the file
/// cut short at several points, empty, only its first bytes, with bytes flipped (a fixed seed),
/// with an absurd length in its first length-like fields, and, for zip, SQLite and JSON
/// containers, with the container itself damaged (a corrupt entry, a broken directory, a bad page
/// size, nesting far deeper than any real file). No variant is the sample itself.
pub fn malformed_variants(sample: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut variants: Vec<(String, Vec<u8>)> = Vec::new();
    let len = sample.len();
    variants.push(("empty".into(), Vec::new()));
    for (label, at) in
        [("one byte", 1), ("a quarter", len / 4), ("half", len / 2), ("three quarters", len * 3 / 4), ("all but the last byte", len.saturating_sub(1))]
    {
        if at < len {
            variants.push((format!("cut to {label} ({at} of {len} bytes)"), sample[..at].to_vec()));
        }
    }
    if len > 16 {
        variants.push(("only the first 16 bytes".into(), sample[..16].to_vec()));
    }
    // xorshift64 with a fixed seed: the same flips every run.
    let mut state = 0x9E37_79B9_7F4A_7C15_u64 ^ len as u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    if len > 0 {
        for round in 0..24 {
            let mut bytes = sample.to_vec();
            let flips = 1 + (next() % 8) as usize;
            for _ in 0..flips {
                let at = (next() % len as u64) as usize;
                bytes[at] ^= (next() % 255 + 1) as u8;
            }
            variants.push((format!("{flips} bytes flipped (round {round})"), bytes));
        }
        // Length-like fields near the start set to the largest value.
        for at in [4usize, 8, 12, 16, 18, 22] {
            if at + 4 <= len {
                let mut bytes = sample.to_vec();
                bytes[at..at + 4].copy_from_slice(&[0xFF; 4]);
                variants.push((format!("bytes {at}..{} set to 0xFFFFFFFF", at + 4), bytes));
            }
        }
    }
    if sample.starts_with(b"PK\x03\x04") {
        if len > 64 {
            let mut bytes = sample.to_vec();
            for byte in &mut bytes[30..len.min(30 + 32)] {
                *byte = !*byte;
            }
            variants.push(("zip: the first entry's name and data inverted".into(), bytes));
        }
        if len >= 22 {
            let mut bytes = sample.to_vec();
            let end = len - 22;
            if bytes[end..end + 4] == *b"PK\x05\x06" {
                bytes[end + 10..end + 12].copy_from_slice(&[0xFF, 0xFF]);
                bytes[end + 16..end + 20].copy_from_slice(&[0xFF; 4]);
                variants.push(("zip: the end record claims 65535 entries at an offset past the end".into(), bytes));
            }
            let mut bytes = sample.to_vec();
            bytes.truncate(len - 22);
            variants.push(("zip: no end record".into(), bytes));
        }
    }
    if sample.starts_with(b"SQLite format 3\0") && len >= 100 {
        let mut bytes = sample.to_vec();
        bytes[16..18].copy_from_slice(&[0x00, 0x03]);
        variants.push(("SQLite: page size 3".into(), bytes));
        let mut bytes = sample.to_vec();
        bytes[28..32].copy_from_slice(&[0x7F, 0xFF, 0xFF, 0xFF]);
        variants.push(("SQLite: database size of 2^31 pages".into(), bytes));
        if len > 200 {
            let mut bytes = sample.to_vec();
            for byte in &mut bytes[100..len.min(100 + 64)] {
                *byte = 0xFF;
            }
            variants.push(("SQLite: the first page's tree header overwritten".into(), bytes));
        }
    }
    let first = sample.iter().find(|byte| !byte.is_ascii_whitespace());
    if matches!(first, Some(b'{' | b'[')) {
        let depth = 100_000;
        let mut nested = "[".repeat(depth).into_bytes();
        nested.extend("]".repeat(depth).into_bytes());
        variants.push((format!("JSON nested {depth} deep"), nested));
        let mut bytes = b"{\"\":".to_vec();
        bytes.extend("[".repeat(depth).into_bytes());
        variants.push(("JSON: an unclosed nest".into(), bytes));
        variants.push(("JSON: a number of 100000 digits".into(), format!("[{}]", "9".repeat(100_000)).into_bytes()));
    }
    variants.retain(|(_, bytes)| bytes.as_slice() != sample);
    variants
}

/// Opens every [`malformed_variants`] of each sample (valid files of the kit's own format, its
/// `conformance/` samples say) as `name`, and checks that the kit refuses the damage with an
/// error, or opens what it can. A document that does open is inspected and rendered (a 64 × 64
/// area) too. Each open runs on its own thread: a panic, or no answer within `budget`, is a
/// problem. A file must never take the engine down: in the page, a panic stops the worker and an
/// endless loop freezes the editor.
///
/// It cannot catch a stack overflow or an allocation the system refuses: those abort the test
/// process, which fails the test all the same.
pub fn check_malformed<D: KitDocument + 'static>(name: &str, samples: &[&[u8]], budget: std::time::Duration) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    for (index, sample) in samples.iter().enumerate() {
        if let Err(message) = D::open(name, sample) {
            problems.push(format!("sample {index} is not a valid file: {message}"));
            continue;
        }
        for (label, bytes) in malformed_variants(sample) {
            let file = name.to_string();
            let (send, receive) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if let Ok(doc) = D::open(&file, &bytes) {
                        let _ = doc.inspect();
                        let _ = doc.render(0.0, 0.0, 1.0, doc.width().min(64), doc.height().min(64));
                    }
                }));
                let _ = send.send(outcome.map_err(|panic| {
                    panic.downcast_ref::<&str>().map(|text| text.to_string()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default()
                }));
            });
            match receive.recv_timeout(budget) {
                Ok(Ok(())) => {}
                Ok(Err(message)) => problems.push(format!("sample {index}, {label}: panicked: {message}")),
                Err(_) => problems.push(format!("sample {index}, {label}: did not return within {budget:?}")),
            }
        }
    }
    if problems.is_empty() { Ok(()) } else { Err(problems) }
}

#[cfg(test)]
mod command_tests {
    use super::check_commands;
    use crate::KitCommand;
    use serde_json::json;

    fn read(id: &str, description: &str) -> KitCommand {
        KitCommand { id: id.into(), title: "Get Cell".into(), description: description.into(), schema: Some(json!({})), enabled: true, ..Default::default() }
    }

    #[test]
    fn a_described_read_command_with_an_output_passes() {
        let mut command = read("cell.get", "Reads one cell's value and formula without changing the sheet.");
        command.output_schema = Some(json!({ "type": "object" }));
        assert_eq!(check_commands(&[command], &[]), Ok(()));
    }

    #[test]
    fn titles_notation_and_short_descriptions_fail() {
        let mut edit = read("cell.set", "Params: {ref, value}");
        edit.mutates = true;
        let mut same = read("cell.clear", "get cell.");
        same.mutates = true;
        let mut short = read("cell.copy", "Copies a cell.");
        short.mutates = true;
        let mut none = read("cell.cut", "");
        none.mutates = true;
        let problems = check_commands(&[edit, same, short, none], &[]).unwrap_err();
        assert_eq!(problems.len(), 4, "{problems:#?}");
        assert!(problems[0].contains("parameter notation"));
        assert!(problems[1].contains("repeats the title"));
        assert!(problems[2].contains("too short"));
        assert!(problems[3].contains("no description"));
    }

    #[test]
    fn an_offered_read_command_needs_an_output_or_a_reason() {
        let zoom = read("view.zoomIn", "Zooms the view in one step without changing the document.");
        let problems = check_commands(std::slice::from_ref(&zoom), &[]).unwrap_err();
        assert!(problems[0].contains("output_schema"), "{problems:?}");
        assert_eq!(check_commands(std::slice::from_ref(&zoom), &[("view.zoomIn", "moves the view only")]), Ok(()));
        let unoffered = KitCommand { schema: None, ..zoom.clone() };
        assert_eq!(check_commands(&[unoffered], &[]), Ok(()), "a command no agent is offered needs no output schema");
    }

    #[test]
    fn a_stale_or_unexplained_no_output_entry_fails() {
        let zoom = read("view.zoomIn", "Zooms the view in one step without changing the document.");
        let problems = check_commands(std::slice::from_ref(&zoom), &[("view.zoomIn", " "), ("view.gone", "removed")]).unwrap_err();
        assert!(problems.iter().any(|problem| problem.contains("no reason for view.zoomIn")), "{problems:?}");
        assert!(problems.iter().any(|problem| problem.contains("view.gone, which is not a command")), "{problems:?}");
    }
}

#[cfg(test)]
mod unknown_param_tests {
    use super::check_unknown_params;
    use crate::{KitCommand, KitDocument};
    use serde_json::{Value, json};

    /// `strict` refuses keys its schema does not name; the other commands ignore them, and
    /// `boom` panics.
    struct Mock;

    impl KitDocument for Mock {
        fn open(_: &str, _: &[u8]) -> Result<Self, String> {
            Ok(Mock)
        }
        fn create(_: &str, _: u32, _: u32) -> Result<Self, String> {
            Ok(Mock)
        }
        fn width(&self) -> u32 {
            1
        }
        fn height(&self) -> u32 {
            1
        }
        fn revision(&self) -> u64 {
            0
        }
        fn dirty(&self) -> bool {
            false
        }
        fn render(&self, _: f64, _: f64, _: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; (width * height * 4) as usize])
        }
        fn render_area(&self, _: i32, _: i32, _: i32, _: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; (width * height * 4) as usize])
        }
        fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
            match command {
                "strict" => match params.as_object().and_then(|object| object.keys().find(|key| *key != "size")) {
                    Some(key) => Err(format!("unknown parameter `{key}`")),
                    None => Ok(Value::Null),
                },
                "vague" if params.get("size").is_none() => Err("size is required".into()),
                "boom" => panic!("boom"),
                _ => Ok(Value::Null),
            }
        }
        fn inspect(&self) -> Result<Value, String> {
            Ok(json!({}))
        }
        fn commands(&self) -> Vec<KitCommand> {
            let command = |id: &str, schema: Option<Value>| KitCommand { id: id.into(), title: id.into(), schema, enabled: true, ..Default::default() };
            vec![
                command("strict", Some(json!({ "size": { "type": "number" } }))),
                command("lenient", Some(json!({ "size": { "type": "number" } }))),
                command("vague", Some(json!({ "size": { "type": "number", "required": true } }))),
                command("boom", Some(json!({}))),
                command("unoffered", None),
            ]
        }
        fn save(&self, _: Option<&str>) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn mark_saved(&mut self) {}
    }

    #[test]
    fn names_each_command_that_does_not_refuse_an_unknown_key() {
        let problems = check_unknown_params(|| Mock, &[]).unwrap_err();
        assert_eq!(problems.len(), 3, "{problems:#?}");
        assert!(problems.iter().any(|problem| problem.starts_with("lenient:") && problem.contains("accepted")), "{problems:#?}");
        assert!(problems.iter().any(|problem| problem.starts_with("vague:") && problem.contains("does not name")), "{problems:#?}");
        assert!(problems.iter().any(|problem| problem.starts_with("boom:") && problem.contains("panicked")), "{problems:#?}");
    }

    #[test]
    fn a_command_listed_as_open_with_a_reason_is_skipped() {
        let open = [("lenient", "takes any setting name"), ("vague", "reads a free-form map"), ("boom", "test")];
        assert_eq!(check_unknown_params(|| Mock, &open), Ok(()));
    }

    #[test]
    fn a_stale_or_unexplained_open_entry_fails() {
        let open = [("lenient", " "), ("vague", "reads a free-form map"), ("boom", "test"), ("gone", "removed"), ("unoffered", "no schema")];
        let problems = check_unknown_params(|| Mock, &open).unwrap_err();
        assert!(problems.iter().any(|problem| problem.contains("no reason for lenient")), "{problems:#?}");
        assert!(problems.iter().any(|problem| problem.contains("gone, which is not a command")), "{problems:#?}");
        assert!(problems.iter().any(|problem| problem.contains("unoffered, which has no parameter schema")), "{problems:#?}");
    }
}

#[cfg(test)]
mod malformed_tests {
    use super::{check_malformed, malformed_variants};
    use crate::{KitCommand, KitDocument};
    use serde_json::{Value, json};
    use std::time::Duration;

    /// A "MOCK" header, a little-endian u32 length, then that many payload bytes. `Careful`
    /// checks every length; `Careless` trusts the header and indexes past the end; `Stuck` never
    /// returns on an empty file.
    trait Reader {
        fn read(bytes: &[u8]) -> Result<(), String>;
    }
    struct Careful;
    struct Careless;
    struct Stuck;
    impl Reader for Careful {
        fn read(bytes: &[u8]) -> Result<(), String> {
            let rest = bytes.strip_prefix(b"MOCK").ok_or("not a mock file")?;
            let len = rest.get(..4).ok_or("truncated header")?;
            let len = u32::from_le_bytes([len[0], len[1], len[2], len[3]]) as usize;
            if rest.len() - 4 != len {
                return Err("payload length does not match".into());
            }
            Ok(())
        }
    }
    impl Reader for Careless {
        fn read(bytes: &[u8]) -> Result<(), String> {
            let len = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
            let _last = bytes[8 + len - 1];
            Ok(())
        }
    }
    impl Reader for Stuck {
        fn read(bytes: &[u8]) -> Result<(), String> {
            while bytes.is_empty() {
                std::thread::sleep(Duration::from_secs(1));
            }
            Careful::read(bytes)
        }
    }

    struct Doc<R>(std::marker::PhantomData<R>);
    impl<R: Reader> KitDocument for Doc<R> {
        fn open(_: &str, bytes: &[u8]) -> Result<Self, String> {
            R::read(bytes).map(|()| Doc(std::marker::PhantomData))
        }
        fn create(_: &str, _: u32, _: u32) -> Result<Self, String> {
            Ok(Doc(std::marker::PhantomData))
        }
        fn width(&self) -> u32 {
            2
        }
        fn height(&self) -> u32 {
            2
        }
        fn revision(&self) -> u64 {
            0
        }
        fn dirty(&self) -> bool {
            false
        }
        fn render(&self, _: f64, _: f64, _: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; (width * height * 4) as usize])
        }
        fn render_area(&self, _: i32, _: i32, _: i32, _: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; (width * height * 4) as usize])
        }
        fn execute(&mut self, _: &str, _: Value) -> Result<Value, String> {
            Ok(Value::Null)
        }
        fn inspect(&self) -> Result<Value, String> {
            Ok(json!({ "canUndo": false, "canRedo": false }))
        }
        fn commands(&self) -> Vec<KitCommand> {
            Vec::new()
        }
        fn save(&self, _: Option<&str>) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn mark_saved(&mut self) {}
    }

    fn sample() -> Vec<u8> {
        let payload = b"0123456789abcdef0123456789abcdef";
        let mut bytes = b"MOCK".to_vec();
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn the_variants_are_the_same_every_run_and_cover_truncation_and_emptiness() {
        let first = malformed_variants(&sample());
        assert_eq!(first, malformed_variants(&sample()));
        assert!(first.iter().any(|(_, bytes)| bytes.is_empty()));
        assert!(first.iter().any(|(_, bytes)| bytes.len() == sample().len() - 1));
        assert!(first.iter().all(|(_, bytes)| bytes != &sample()), "a variant is the sample itself");
    }

    #[test]
    fn a_reader_that_checks_every_length_passes() {
        assert_eq!(check_malformed::<Doc<Careful>>("mock.mock", &[&sample()], Duration::from_secs(5)), Ok(()));
    }

    #[test]
    fn a_reader_that_trusts_its_header_is_named_for_panicking() {
        let problems = check_malformed::<Doc<Careless>>("mock.mock", &[&sample()], Duration::from_secs(5)).unwrap_err();
        assert!(problems.iter().any(|problem| problem.contains("panicked")), "{problems:#?}");
    }

    #[test]
    fn a_reader_that_never_returns_is_named_for_hanging() {
        let problems = check_malformed::<Doc<Stuck>>("mock.mock", &[&sample()], Duration::from_millis(300)).unwrap_err();
        assert!(problems.iter().any(|problem| problem.contains("empty") && problem.contains("did not return")), "{problems:#?}");
    }
}

#[cfg(test)]
mod text_tests {
    use super::{check_text, check_text_answer};
    use crate::text::{DocumentText, TextBuilder, TextPart};
    use crate::{KitCommand, KitDocument};
    use serde_json::{Value, json};
    use std::cell::Cell;

    /// Pages of words; `mode` makes it break one rule.
    struct Pages {
        pages: Vec<&'static str>,
        mode: &'static str,
        revision: Cell<u64>,
    }

    impl KitDocument for Pages {
        fn open(_: &str, _: &[u8]) -> Result<Self, String> {
            Err("no files".into())
        }
        fn create(_: &str, _: u32, _: u32) -> Result<Self, String> {
            Err("no files".into())
        }
        fn width(&self) -> u32 {
            1
        }
        fn height(&self) -> u32 {
            1
        }
        fn revision(&self) -> u64 {
            self.revision.get()
        }
        fn dirty(&self) -> bool {
            false
        }
        fn render(&self, _: f64, _: f64, _: f64, w: u32, h: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; w as usize * h as usize * 4])
        }
        fn render_area(&self, _: i32, _: i32, _: i32, _: i32, w: u32, h: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; w as usize * h as usize * 4])
        }
        fn execute(&mut self, command: &str, _: Value) -> Result<Value, String> {
            Err(format!("unknown command {command}"))
        }
        fn inspect(&self) -> Result<Value, String> {
            Ok(json!({ "canUndo": false, "canRedo": false }))
        }
        fn commands(&self) -> Vec<KitCommand> {
            Vec::new()
        }
        fn save(&self, _: Option<&str>) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn mark_saved(&mut self) {}
        fn text(&self, limit: usize) -> Result<DocumentText, String> {
            if self.mode == "side-effect" {
                self.revision.set(self.revision.get() + 1);
            }
            let mut text = TextBuilder::new(if self.mode == "ignores-limit" { usize::MAX } else { limit });
            for (n, page) in self.pages.iter().enumerate() {
                text.part(format!("Page {}", n + 1), page);
            }
            let mut text = text.finish();
            if self.mode == "never-truncated" {
                text.truncated = false;
            }
            if self.mode == "part-past-end"
                && let Some(part) = text.parts.last_mut()
            {
                part.end += 1;
            }
            Ok(text)
        }
    }

    fn doc(mode: &'static str) -> Pages {
        Pages { pages: vec!["Quarterly report", "", "Revenue grew 12%"], mode, revision: Cell::new(0) }
    }

    #[test]
    fn passes_a_kit_that_keeps_the_rules() {
        let text = check_text(&doc("")).unwrap();
        assert_eq!(text.text, "Quarterly report\nRevenue grew 12%");
        assert_eq!(text.parts.iter().map(|part| part.label.as_str()).collect::<Vec<_>>(), ["Page 1", "Page 3"]);
        let empty = Pages { pages: vec![""], ..doc("") };
        assert_eq!(check_text(&empty).unwrap(), DocumentText::default());
    }

    #[test]
    fn names_each_broken_rule() {
        for (mode, error) in [
            ("side-effect", "text changed the document"),
            ("ignores-limit", "over the limit"),
            ("never-truncated", "is not truncated"),
            ("part-past-end", "outside the text"),
        ] {
            let found = check_text(&doc(mode)).unwrap_err();
            assert!(found.contains(error), "{mode}: {found}");
        }
        let overlapping = DocumentText {
            text: "abcdef".into(),
            truncated: false,
            parts: vec![TextPart { label: "A".into(), start: 0, end: 4 }, TextPart { label: "B".into(), start: 3, end: 6 }],
        };
        assert!(check_text_answer(&overlapping, 10).unwrap_err().contains("overlaps"));
        let unlabelled = DocumentText { parts: vec![TextPart { label: " ".into(), start: 0, end: 1 }], ..overlapping };
        assert!(check_text_answer(&unlabelled, 10).unwrap_err().contains("no label"));
    }
}

/// regressions/issue-path-in-plain-string: a command an agent is offered names a file in a plain
/// string (a workspace audit: film's `file.projectManager { destination }` wrote a
/// project outside the workspace, past the `file`-type gate).
#[cfg(test)]
mod file_parameter_tests {
    use super::check_file_parameters;
    use crate::KitCommand;
    use serde_json::{Value, json};

    fn command(id: &str, schema: Value) -> KitCommand {
        KitCommand { id: id.into(), title: id.into(), schema: Some(schema), enabled: true, ..Default::default() }
    }

    const MANIFEST: &str = r#"{ "id": "kit.x", "agent": { "prefix": "x", "exclude": ["prefs.*"] } }"#;

    #[test]
    fn a_path_in_a_plain_string_is_a_problem_until_typed_or_reviewed() {
        let commands = [
            command("file.projectManager", json!({ "destination": { "type": "string", "required": true }, "wait": { "type": "boolean" } })),
            command("content.update", json!({ "page": { "type": "integer" }, "image": { "type": "string", "description": "The image file path." } })),
            command("html.setSource", json!({ "source": { "type": "string", "notFile": true, "description": "The HTML source." } })),
            command("lut.import", json!({ "path": { "type": "file", "access": "read", "accept": ["cube"] }, "name": { "type": "string" } })),
            command("prefs.folder", json!({ "folder": { "type": "string" } })),
            command("text.set", json!({ "text": { "type": "string" }, "mode": { "type": "string", "enum": ["file", "path"] } })),
            KitCommand { id: "file.export".into(), params: Some("{path}".into()), ..Default::default() },
        ];
        let problems = check_file_parameters(&commands, MANIFEST, &[]).unwrap_err();
        assert_eq!(
            problems,
            [
                "file.projectManager: `destination` is a plain string, but its name says `destination`: type it `file` (KHP A28), or mark it \"notFile\": true once reviewed",
                "content.update: `image` is a plain string, but its description says `file path`: type it `file` (KHP A28), or mark it \"notFile\": true once reviewed",
            ]
        );
        // A command whose `file` parameter keeps it off the agent's list is offered when the kit
        // declares it sandboxed, and then its plain strings count too.
        let sandboxed = [command("lut.import", json!({ "path": { "type": "file", "access": "read" }, "folder": { "type": "string" } }))];
        assert_eq!(check_file_parameters(&sandboxed, MANIFEST, &[]), Ok(()));
        assert_eq!(check_file_parameters(&sandboxed, MANIFEST, &["lut.import"]).unwrap_err().len(), 1);
        assert!(crate::schema::validate(&json!({ "source": { "type": "string", "notFile": true } })).is_ok());
        assert!(crate::schema::validate(&json!({ "source": { "type": "string", "notFile": false } })).is_err());
        assert!(crate::schema::validate(&json!({ "count": { "type": "integer", "notFile": true } })).is_err());
    }
}

#[cfg(test)]
mod context_tests {
    use super::{check_commands, check_context};
    use crate::{CallContext, EditorState, KitCommand, KitDocument};
    use serde_json::{Value, json};

    /// Slides `s1`..`s3` on two slides, with a current slide and a selection, which `inspect`
    /// reports for the kit's own editor (`/slide`, `/selection`, as real kits do). `fault` breaks
    /// one rule: `edits` moves the revision when the context is set, `content` changes the
    /// document's content, `undo` enters the undo history, `forgets` restores the slide but not
    /// the selection.
    struct Deck {
        current: u64,
        selection: Vec<Value>,
        revision: u64,
        notes: &'static str,
        can_undo: bool,
        fault: &'static str,
    }

    /// Where [`Deck`]'s `inspect` reports its editor state.
    const DECK_STATE: &[&str] = &["/slide", "/selection"];

    impl Deck {
        fn new(fault: &'static str) -> Self {
            Self { current: 0, selection: vec![json!("s1")], revision: 0, notes: "Plan", can_undo: false, fault }
        }
    }

    impl KitDocument for Deck {
        fn open(_: &str, _: &[u8]) -> Result<Self, String> {
            Ok(Self::new(""))
        }
        fn create(name: &str, _: u32, _: u32) -> Result<Self, String> {
            Self::open(name, &[])
        }
        fn width(&self) -> u32 {
            1
        }
        fn height(&self) -> u32 {
            1
        }
        fn revision(&self) -> u64 {
            self.revision
        }
        fn dirty(&self) -> bool {
            self.revision > 0
        }
        fn render(&self, _: f64, _: f64, _: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; (width * height * 4) as usize])
        }
        fn render_area(&self, _: i32, _: i32, _: i32, _: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; (width * height * 4) as usize])
        }
        fn execute(&mut self, command: &str, _: Value) -> Result<Value, String> {
            Err(format!("unknown command {command}"))
        }
        fn inspect(&self) -> Result<Value, String> {
            Ok(json!({
                "canUndo": self.can_undo, "canRedo": false, "slides": 2, "notes": self.notes,
                "slide": self.current + 1, "selection": self.selection,
            }))
        }
        fn commands(&self) -> Vec<KitCommand> {
            Vec::new()
        }
        fn save(&self, _: Option<&str>) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn mark_saved(&mut self) {}
        fn editor_state(&self) -> Value {
            json!({ "slide": self.current, "selection": self.selection })
        }
        fn restore_editor_state(&mut self, saved: &Value) -> Result<(), String> {
            self.current = saved["slide"].as_u64().ok_or("not a saved state")?;
            if self.fault != "forgets" {
                self.selection = saved["selection"].as_array().cloned().unwrap_or_default();
            }
            Ok(())
        }
        fn set_context(&mut self, context: &CallContext) -> Result<(), String> {
            if let Some(slide) = context.part.as_ref().and_then(|part| part["slide"].as_u64()) {
                self.current = slide - 1;
            }
            if !context.on.is_empty() {
                self.selection = context.on.clone();
            }
            match self.fault {
                "edits" => self.revision += 1,
                "content" => self.notes = "Plan (edited)",
                "undo" => self.can_undo = true,
                _ => {}
            }
            Ok(())
        }
    }

    /// The hooks' defaults: a document without them.
    struct Plain;

    impl KitDocument for Plain {
        fn open(_: &str, _: &[u8]) -> Result<Self, String> {
            Ok(Self)
        }
        fn create(_: &str, _: u32, _: u32) -> Result<Self, String> {
            Ok(Self)
        }
        fn width(&self) -> u32 {
            1
        }
        fn height(&self) -> u32 {
            1
        }
        fn revision(&self) -> u64 {
            0
        }
        fn dirty(&self) -> bool {
            false
        }
        fn render(&self, _: f64, _: f64, _: f64, _: u32, _: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; 4])
        }
        fn render_area(&self, _: i32, _: i32, _: i32, _: i32, _: u32, _: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; 4])
        }
        fn execute(&mut self, command: &str, _: Value) -> Result<Value, String> {
            Err(format!("unknown command {command}"))
        }
        fn inspect(&self) -> Result<Value, String> {
            Ok(json!({ "canUndo": false, "canRedo": false }))
        }
        fn commands(&self) -> Vec<KitCommand> {
            Vec::new()
        }
        fn save(&self, _: Option<&str>) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn mark_saved(&mut self) {}
    }

    fn deck() -> CallContext {
        CallContext { on: vec![json!("s2")], part: Some(json!({ "slide": 2 })), time: None }
    }

    /// An image whose editor state is its selected layers and its selected area (a marquee,
    /// `[x, y, width, height]`), which `inspect` reports at `/area`. No call
    /// context sets the area; `fault` `area` makes `set_context` clear it, `forgets` makes the
    /// restore leave it.
    struct Canvas {
        selection: Vec<Value>,
        area: Value,
        fault: &'static str,
    }

    const CANVAS_STATE: &[&str] = &["/selection", "/area"];

    impl KitDocument for Canvas {
        fn open(_: &str, _: &[u8]) -> Result<Self, String> {
            Ok(Self { selection: Vec::new(), area: json!([10, 10, 40, 30]), fault: "" })
        }
        fn create(name: &str, _: u32, _: u32) -> Result<Self, String> {
            Self::open(name, &[])
        }
        fn width(&self) -> u32 {
            1
        }
        fn height(&self) -> u32 {
            1
        }
        fn revision(&self) -> u64 {
            0
        }
        fn dirty(&self) -> bool {
            false
        }
        fn render(&self, _: f64, _: f64, _: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; (width * height * 4) as usize])
        }
        fn render_area(&self, _: i32, _: i32, _: i32, _: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; (width * height * 4) as usize])
        }
        fn execute(&mut self, command: &str, _: Value) -> Result<Value, String> {
            Err(format!("unknown command {command}"))
        }
        fn inspect(&self) -> Result<Value, String> {
            Ok(json!({ "canUndo": false, "canRedo": false, "layers": 2, "selection": self.selection, "area": self.area }))
        }
        fn commands(&self) -> Vec<KitCommand> {
            vec![KitCommand { id: "selection.fill".into(), reads: &[EditorState::Area], mutates: true, ..Default::default() }]
        }
        fn save(&self, _: Option<&str>) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn mark_saved(&mut self) {}
        fn editor_state(&self) -> Value {
            json!({ "selection": self.selection, "area": self.area })
        }
        fn restore_editor_state(&mut self, saved: &Value) -> Result<(), String> {
            self.selection = saved["selection"].as_array().cloned().unwrap_or_default();
            if self.fault != "forgets" {
                self.area = saved["area"].clone();
            }
            Ok(())
        }
        fn set_context(&mut self, context: &CallContext) -> Result<(), String> {
            if !context.on.is_empty() {
                self.selection = context.on.clone();
            }
            if self.fault == "area" || self.fault == "forgets" {
                self.area = Value::Null;
            }
            Ok(())
        }
    }

    /// a kit that keeps a selected area declares it in its editor-state list;
    /// the check then passes, names an area left out of the list as content, and names a restore
    /// that does not put the area back.
    #[test]
    fn a_selected_area_is_checked_as_editor_state() {
        let on = CallContext { on: vec![json!(2)], part: None, time: None };
        let mut canvas = Canvas::open("a", &[]).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(check_context(&mut canvas, &on, CANVAS_STATE), Ok(()));
        assert_eq!(canvas.commands()[0].reads, &[EditorState::Area]);
        let mut cleared = Canvas { fault: "area", ..Canvas::open("a", &[]).unwrap_or_else(|error| panic!("{error}")) };
        let undeclared = check_context(&mut cleared, &on, &["/selection"]).err().unwrap_or_default();
        assert!(undeclared.contains("set_context changed the document's content"), "an area left out of the list is content: {undeclared}");
        let mut forgets = Canvas { fault: "forgets", ..Canvas::open("a", &[]).unwrap_or_else(|error| panic!("{error}")) };
        let problem = check_context(&mut forgets, &on, CANVAS_STATE).err().unwrap_or_default();
        assert!(problem.contains("after restore_editor_state the editor state is"), "{problem}");
    }

    #[test]
    fn setting_and_restoring_the_context_changes_nothing_in_the_document() {
        let mut doc = Deck::new("");
        assert_eq!(check_context(&mut doc, &deck(), DECK_STATE), Ok(()));
        assert_eq!(doc.editor_state(), json!({ "slide": 0, "selection": ["s1"] }), "the state is what it was");
        let mut sneaky = Deck::new("edits");
        let problem = check_context(&mut sneaky, &deck(), DECK_STATE).err().unwrap_or_default();
        assert!(problem.contains("set_context changed the document"), "{problem}");
    }

    /// regressions/issue-check-context-editor-state: real kits report their editor state (the
    /// current slide, the selection, the playhead) in `inspect()` for their own editors, so a
    /// context that moves anything changed what `inspect` answers and the check refused every
    /// real move. It compares the document's content (inspect without the declared editor state),
    /// revision, dirty state and undo history instead, and that the restore puts the state back.
    #[test]
    fn a_context_that_moves_the_editor_passes_and_each_broken_rule_is_named() {
        let mut doc = Deck::new("");
        let moved = deck();
        assert_eq!(check_context(&mut doc, &moved, DECK_STATE), Ok(()), "a real move: slide 2, another selection");
        assert_eq!(doc.inspect().ok().map(|inspected| inspected["slide"].clone()), Some(json!(1)), "the restore took the editor back");
        let undeclared = check_context(&mut Deck::new(""), &moved, &[]).err().unwrap_or_default();
        assert!(undeclared.contains("set_context changed the document's content"), "editor state the kit does not declare is content: {undeclared}");
        for (fault, words) in [
            ("edits", "set_context changed the document: revision"),
            ("content", "set_context changed the document's content"),
            ("undo", "set_context changed the undo history"),
            ("forgets", "after restore_editor_state the editor state is"),
        ] {
            let problem = check_context(&mut Deck::new(fault), &moved, DECK_STATE).err().unwrap_or_default();
            assert!(problem.contains(words), "{fault}: {problem}");
        }
    }

    #[test]
    fn a_kit_without_the_hooks_keeps_no_state_and_refuses_every_member_named() {
        let mut doc = Plain;
        assert_eq!(doc.editor_state(), Value::Null);
        assert_eq!(doc.restore_editor_state(&Value::Null), Ok(()));
        assert_eq!(doc.set_context(&CallContext::default()), Ok(()));
        let refused = doc.set_context(&CallContext { on: vec![json!("a")], part: None, time: Some(1.0) }).err().unwrap_or_default();
        assert!(refused.contains("`on`, `time`") && !refused.contains("`part`"), "{refused}");
        let context: CallContext = serde_json::from_value(json!({ "part": { "slide": 1 } })).unwrap_or_default();
        assert_eq!(context.given(), ["part"]);
    }

    /// The editor's mode (a 3D kit's edit mode, a document's editing mode) and its
    /// active object (the layer, track or object new content goes to) are editor state a command
    /// reads too; hosts list them in `x-khp-reads` by name.
    #[test]
    fn the_mode_and_the_active_object_are_editor_state_a_command_reads() {
        let reads = [EditorState::Selection, EditorState::Part, EditorState::Time, EditorState::Mode, EditorState::Active];
        let names: Vec<&str> = reads.iter().map(|read| read.as_str()).collect();
        assert_eq!(names, ["selection", "part", "time", "mode", "active"]);
        assert_eq!(serde_json::to_value(reads).unwrap_or_default(), json!(names), "serialized as hosts list them");
        let extrude = KitCommand { id: "mesh.extrude".into(), reads: &[EditorState::Mode, EditorState::Selection], ..Default::default() };
        assert_eq!(serde_json::to_value(&extrude).unwrap_or_default()["reads"], json!(["mode", "selection"]));
    }

    /// the selected area (a photo kit's marquee or pixel selection, not the
    /// selected objects) is editor state a command reads too, listed as `area`.
    #[test]
    fn the_selected_area_is_editor_state_a_command_reads() {
        assert_eq!(EditorState::Area.as_str(), "area");
        assert_eq!(serde_json::to_value(EditorState::Area).unwrap_or_default(), json!("area"));
        assert_eq!(serde_json::from_value::<EditorState>(json!("area")).ok(), Some(EditorState::Area));
        let fill = KitCommand { id: "selection.fill".into(), reads: &[EditorState::Area, EditorState::Active], ..Default::default() };
        assert_eq!(serde_json::to_value(&fill).unwrap_or_default()["reads"], json!(["area", "active"]));
    }

    #[test]
    fn a_commands_metadata_is_listed_with_it_and_its_targets_are_checked() {
        let mark = KitCommand {
            id: "shape.text".into(),
            title: "Set text".into(),
            description: "Sets the text of one object of the current slide.".into(),
            schema: Some(json!({ "id": { "type": "string" }, "text": { "type": "string" } })),
            mutates: true,
            targets: Some("id"),
            reads: &[EditorState::Part],
            ..Default::default()
        };
        let listed = serde_json::to_value(&mark).unwrap_or_default();
        assert_eq!((listed["targets"].clone(), listed["reads"].clone()), (json!("id"), json!(["part"])));
        assert!(serde_json::to_value(KitCommand::default()).unwrap_or_default().get("reads").is_none(), "nothing listed when nothing is read");
        assert_eq!(check_commands(std::slice::from_ref(&mark), &[]), Ok(()));
        let wrong = KitCommand { targets: Some("text2"), ..mark };
        let problems = check_commands(&[wrong], &[]).err().unwrap_or_default();
        assert!(problems.iter().any(|problem| problem.contains("`text2`")), "{problems:?}");
    }
}

/// `check_required` proves a kit's opt-in (`KitCommand::notation_required`) command by command.
#[cfg(test)]
mod required_tests {
    use super::check_required;
    use crate::{KitCommand, KitDocument};
    use serde_json::{Value, json};

    /// Layers by id. `layer.rename` needs both its parameters, as its notation says; `layer.fill`
    /// takes the foreground colour when `color` is left out, though its notation marks it neither
    /// optional nor defaulted; `layer.move` needs `dx`, though its notation marks it optional.
    struct Layers;

    impl KitDocument for Layers {
        fn open(_: &str, _: &[u8]) -> Result<Self, String> {
            Ok(Layers)
        }
        fn create(_: &str, _: u32, _: u32) -> Result<Self, String> {
            Ok(Layers)
        }
        fn width(&self) -> u32 {
            1
        }
        fn height(&self) -> u32 {
            1
        }
        fn revision(&self) -> u64 {
            0
        }
        fn dirty(&self) -> bool {
            false
        }
        fn render(&self, _: f64, _: f64, _: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; (width * height * 4) as usize])
        }
        fn render_area(&self, _: i32, _: i32, _: i32, _: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
            Ok(vec![0; (width * height * 4) as usize])
        }
        fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
            let needs: &[&str] = match command {
                "layer.rename" => &["layer", "name"],
                "layer.fill" | "layer.hide" => &["layer"],
                "layer.move" => &["layer", "dx"],
                "layer.boom" => panic!("boom"),
                _ => return Err(format!("unknown command {command}")),
            };
            match needs.iter().find(|key| params.get(**key).is_none()) {
                Some(key) => Err(format!("`{key}` is missing")),
                None => Ok(Value::Null),
            }
        }
        fn inspect(&self) -> Result<Value, String> {
            Ok(json!({ "canUndo": false, "canRedo": false }))
        }
        fn commands(&self) -> Vec<KitCommand> {
            let command = |id: &str, params: &str, opted: bool| {
                KitCommand { id: id.into(), title: id.into(), params: Some(params.into()), notation_required: opted, enabled: true, ..Default::default() }
                    .with_kit_schema()
            };
            vec![
                command("layer.rename", r#"{"layer":id,"name":str}"#, true),
                command("layer.fill", r##"{"layer":id,"color":"#rrggbb"}"##, true),
                command("layer.move", r#"{"layer":id,"dx":f64?}"#, true),
                command("layer.hide", r#"{"layer":id}"#, false),
                command("layer.boom", r#"{"layer":id}"#, true),
            ]
        }
        fn save(&self, _: Option<&str>) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        fn mark_saved(&mut self) {}
    }

    #[test]
    fn a_right_declaration_passes() {
        let calls = [("layer.rename", json!({ "layer": 1, "name": "Ink" }))];
        let only = |id: &str| id == "layer.rename";
        assert_eq!(check_required(|| Layers, &calls, only), Ok(()));
    }

    #[test]
    fn a_wrong_declaration_is_named_in_both_directions() {
        let calls = [
            ("layer.rename", json!({ "layer": 1, "name": "Ink" })),
            ("layer.fill", json!({ "layer": 1, "color": "#ffffff" })),
            ("layer.move", json!({ "layer": 1 })),
            ("layer.boom", json!({ "layer": 1 })),
        ];
        let problems = check_required(|| Layers, &calls, |_| true).unwrap_err();
        let about = |id: &str| problems.iter().filter(|problem| problem.starts_with(&format!("{id}:"))).cloned().collect::<Vec<_>>();
        assert!(about("layer.rename").is_empty(), "{problems:#?}");
        assert!(about("layer.fill").iter().any(|problem| problem.contains("`color`") && problem.contains("runs without it")), "too strict: {problems:#?}");
        assert!(about("layer.move").iter().any(|problem| problem.contains("only its required parameters")), "too loose: {problems:#?}");
        assert!(about("layer.boom").iter().any(|problem| problem.contains("panicked")), "{problems:#?}");
    }

    #[test]
    fn every_opted_in_command_needs_a_call_with_exactly_its_required_parameters() {
        let calls = [("layer.rename", json!({ "layer": 1 })), ("layer.hide", json!({ "layer": 1 })), ("layer.gone", json!({}))];
        let problems = check_required(|| Layers, &calls, |_| true).unwrap_err();
        let has = |words: &[&str]| problems.iter().any(|problem| words.iter().all(|word| problem.contains(word)));
        assert!(has(&["layer.rename:", "`name`", "exactly its required parameters"]), "{problems:#?}");
        assert!(has(&["layer.hide:", "not opted in"]), "{problems:#?}");
        assert!(has(&["layer.gone", "not a command"]), "{problems:#?}");
        assert!(has(&["layer.fill:", "no call"]), "{problems:#?}");
    }
}

#[cfg(test)]
mod id_params_tests {
    use super::check_id_params;
    use crate::KitCommand;
    use serde_json::json;

    /// An integer parameter whose name or description says it is an id is reported unless it is
    /// the targets, an object parameter, a place or allowed; a count is not.
    #[test]
    fn integer_ids_must_be_marked() {
        let command = |objects: &'static [&'static str]| KitCommand {
            id: "clip.link".into(),
            title: "Link".into(),
            targets: Some("clip"),
            objects,
            schema: Some(json!({
                "clip": { "type": "integer", "description": "the clip's id" },
                "other": { "type": "integer", "description": "the id of the clip to link" },
                "parentId": { "oneOf": [{ "type": "integer" }, { "type": "string" }] },
                "deltaFrames": { "type": "integer", "description": "frames to move" },
                "items": { "type": "array", "items": { "type": "integer" }, "description": "project item ids" }
            })),
            ..Default::default()
        };
        let problems = check_id_params(&[command(&[])], &[]).unwrap_err();
        let named: Vec<bool> = ["`other`", "`parentId`", "`items`"].iter().map(|param| problems.iter().any(|line| line.contains(param))).collect();
        assert_eq!((problems.len(), named), (3, vec![true, true, true]), "{problems:?}");
        assert!(check_id_params(&[command(&["other", "parentId"])], &[("clip.link", "items")]).is_ok());
    }
}
