//! # kition-sdk
//!
//! The Kition SDK makes an engine editable inside Kition. A kit compiles its engine to
//! WebAssembly: the engine runs in a Web Worker and renders pixels, and Kition draws the editor
//! around them (see the Kition platform's `docs/platform/reference/contract.md`).
//!
//! 1. Implement [`KitDocument`] for one open document of your engine.
//! 2. Export it with [`export_kit_document!`], which generates the JavaScript class Kition loads.
//! 3. Call [`testing::check_contract`] from a test to prove the implementation keeps the contract.
//! 4. If a document refers to other files (a film project's media), or a command names a file
//!    the person granted (a `fh_` handle), read them through [`host`].
//! 5. If the engine renders whole frames, [`raster`] turns one into contract-exact renders.
//! 6. If the engine owns its tools' state machines, implement [`tools::KitTools`] and export it
//!    with [`export_kit_tools!`]; hosts then run the engine's own tools.
//! 7. Under engine contract 2 the document is a KDM replica: implement [`session::KitModel`],
//!    hold a [`session::KitSession`], and export it with `export_kit_session!` (feature `session`).
//! 8. To let agents and hosts verify a document, answer [`KitDocument::check`] with
//!    [`diagnostics::Diagnostic`]s (standard 2.0 A21).
//! 9. If a command produces files (an export), keep them in [`outputs::Outputs`] and serve
//!    [`KitDocument::take_output`] (engine contract E16); the host writes them.
//! 10. If the document's words live outside its object model (page text, text layers), answer
//!     [`KitDocument::text`] with a [`text::TextBuilder`] and list the capability
//!     [`text::CAPABILITY`] (`KitText 1.0`); hosts index the words for search.
//! 11. If commands read editor state (the selection, the current slide or page, the current
//!     time), declare it in [`KitCommand::reads`] (and the id parameter in
//!     [`KitCommand::targets`]), and implement [`KitDocument::editor_state`],
//!     [`KitDocument::restore_editor_state`] and [`KitDocument::set_context`]: hosts then set that
//!     state for one call and put it back ([`testing::check_context`] proves it changes nothing).
//!     A command that names what it acts on by a place (a track, a time) declares
//!     [`KitCommand::places`] and the kit answers [`KitDocument::under`]; one whose effect does
//!     not depend on where its target is says [`KitCommand::position_independent`].
//!
//! ```ignore
//! struct SketchDocument { /* the engine's session */ }
//! impl kition_kit::KitDocument for SketchDocument { /* … */ }
//! kition_kit::export_kit_document!(SketchDocument as "SketchDocument");
//! ```
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

#[cfg(feature = "session")]
pub use kition_kdm as kdm;
use serde::Serialize;
use serde_json::Value;

pub mod diagnostics;
pub mod dispatch;
pub mod failure;
pub mod files;
pub mod host;
pub mod outputs;
pub mod premise;
pub mod raster;
pub mod schema;
#[cfg(feature = "session")]
pub mod session;
pub mod testing;
pub mod text;
pub mod tools;

/// The version of the contract this crate implements; Kition checks it before opening files.
pub const CONTRACT_VERSION: u32 = 1;

/// The largest render side an SDK must accept, in pixels.
pub const MAX_RENDER_SIDE: u32 = 8192;

/// One engine command, as the editor's menus and shortcuts show it. Build it with
/// `..Default::default()` for the fields you leave out, so new optional fields never break a kit.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitCommand {
    /// A stable id, for example `layer.new.layer`.
    pub id: String,
    /// The menu item's title.
    pub title: String,
    /// What the command does, when to use it rather than the commands next to it, and what it
    /// changes or answers: one or two sentences, for people and for agents choosing a command.
    /// Not the title again and not the parameter notation; [`testing::check_commands`] lints it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// The menu path, for example `["Layer", "New"]`; `None` keeps it out of the menus.
    pub menu: Option<Vec<String>>,
    /// A shortcut as `Cmd+Shift+N`, `Alt+Backspace`, or `F12`; `Cmd` is Control off macOS.
    pub shortcut: Option<String>,
    /// A short description of the parameters, for people and for agents.
    pub params: Option<String>,
    /// The parameters as a DeepSeek Harness `ParameterSchemaSpec` (standard E7, A5); a command
    /// without one is not offered to agents as a tool. [`schema::from_kit_params`] derives it
    /// from kit command notation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<serde_json::Value>,
    /// What the command answers, as one DeepSeek Harness `ValueSchemaSpec` (KHP A1 `output.schema`,
    /// checked by [`schema::validate_output`]). Optional: hosts map it to the tool's MCP
    /// `outputSchema` (as JSON Schema, accepting the error result beside it, A18) and list no
    /// output schema for a command without one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
    /// Whether running it changes the document.
    pub mutates: bool,
    /// Whether it can run now.
    pub enabled: bool,
    /// Words an agent's command search finds the command by that its id, title and params do not
    /// say, for example the effect names `effect.apply` takes. Searched, never listed.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    /// The command's top level takes keys its `schema` cannot name (any setting name, the
    /// parameters of a kind chosen at run time), so a host refuses no unknown top-level key of it
    /// and its published JSON Schema says `additionalProperties: true`; say why in `description`.
    /// Off by default: a host refuses every other key with [`schema::refuse_unknown`]'s words
    /// before the command runs (kition-headless).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub open_params: bool,
    /// The name of the parameter that names what the command acts on (`"id"`, `"ids"`): an
    /// agent's run step may give those ids as `on` instead, and the host writes them into this
    /// parameter. Whether it takes one id or a list follows from the parameter's `schema` (an
    /// `array` takes a list); [`schema::check_targets`] checks the declaration. Hosts mark the
    /// parameter `"x-khp-role": "targets"` in its JSON Schema (Kit Process Protocol section 6).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targets: Option<&'static str>,
    /// The editor state the command reads besides its parameters: the selection, the current
    /// part (slide, page), the current time, the mode, the active object ([`EditorState`]). A host
    /// sets the selection, part and time for the command ([`KitDocument::set_context`]) from the
    /// step's `on` and `at` and puts the state back afterwards, so an agent drives the command
    /// without knowing the state exists; the mode and the active object no call context sets, so
    /// hosts tell the model the command depends on them and to set them in the same run. Hosts
    /// list it as `"x-khp-reads"` at the top of the command's JSON Schema.
    #[serde(skip_serializing_if = "<[EditorState]>::is_empty")]
    pub reads: &'static [EditorState],
    /// The parameters that name a place rather than an object: a track, a time, an index
    /// (`["track"]`). A step that names what it acts on by a place (these, or `at.time` for a
    /// command that [`reads`](KitCommand::reads) [`EditorState::Time`]) has, for an agent's write
    /// with `basis`, the premise that the objects under the place are the ones that were there
    /// ([`KitDocument::under`] answers them); a place parameter is never read as an object's id.
    /// Hosts mark each `"x-khp-role": "place"` in its JSON Schema (Kit Process Protocol section 6).
    #[serde(skip_serializing_if = "<[&str]>::is_empty")]
    pub places: &'static [&'static str],
    /// The parameters besides [`KitCommand::targets`] that name objects by id (`["parent"]`,
    /// `["material"]`): a whole number there is an object's id, a premise of an agent's write with
    /// `basis` when it names one. A whole number in any other parameter (a count, a
    /// frame delta, an element index) is never read as an id. Hosts mark each
    /// `"x-khp-role": "object"` in its JSON Schema (Kit Process Protocol section 6).
    ///
    /// A name may be a path to a member nested in the parameter: `"rules[].target"` (the
    /// `target` of each item of `rules`), marked where it is in the JSON Schema; ids are read there
    /// at any depth.
    #[serde(skip_serializing_if = "<[&str]>::is_empty")]
    pub objects: &'static [&'static str],
    /// The types of the objects the target parameter or an object parameter names
    /// (`[("layer", &["Layer"])]`): an id of another type (a comp item whose id is `1`)
    /// is not that parameter's object, and with [`KitCommand::index_numbers`] a number naming no
    /// object of these types is a place. Hosts mark the parameter `"x-khp-types": ["Layer"]` (Kit
    /// Process Protocol section 6). A parameter left out names objects of any type.
    #[serde(skip_serializing_if = "<[(&str, &[&str])]>::is_empty")]
    pub object_types: &'static [(&'static str, &'static [&'static str])],
    /// The target parameter also takes an object by its name, the stored field this names
    /// (`Some("name")`): a value that names no object by id is then a name, and an agent's
    /// write with `basis` has the premise that it names the object it named then (refused as
    /// `relocated` after others renamed it away or gave the name to another). Hosts mark the target
    /// parameter `"x-khp-name": "name"` (Kit Process Protocol section 6).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_field: Option<&'static str>,
    /// Additional parameters taking names, paired with their stored name field, for example
    /// `&[("material", "name")]`. Declare their types in `object_types`; nested paths work as
    /// for `objects`. Hosts mark each parameter `x-khp-name` and guard it like a target name.
    #[serde(skip_serializing_if = "<[(&str, &str)]>::is_empty")]
    pub name_params: &'static [(&'static str, &'static str)],
    /// The prefix of the spelling by which the target parameter ([`KitCommand::targets`]) also
    /// names an object by its place in a list, counted from 1: `Some("#")` when `"#3"` is the
    /// third layer of the comp. Such a value is a place, not an id: an agent's write with `basis`
    /// that gives it has the premise that it names the object it named then
    /// ([`KitDocument::under`] answers what it names now), and a step's `on` refuses it
    /// (`on` takes ids). A value in that spelling in another parameter (`parent: "#2"`) is a place
    /// too, which [`KitDocument::under`] answers. Hosts mark the target parameter
    /// `"x-khp-index": "#"` in its JSON Schema (Kit Process Protocol section 6); a command without a
    /// target parameter may mark another parameter so.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<&'static str>,
    /// The index spelling ([`KitCommand::index`]) counts from the other end of the list: `"#1"` is
    /// the last item stored. [`KitDocument::under`] still answers windows in stored order; the
    /// guard follows the index from that end, and a conflict's `now.spelled` gives where the
    /// object is in this order. Hosts mark the parameter `"x-khp-index-order": "reversed"` (Kit
    /// Process Protocol section 6).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub index_reversed: bool,
    /// The target parameter also reads a whole number that names no object as a place in the
    /// list, counted from 1 (a motion kit's `layer: 3` is the third layer when no layer has the id
    /// 3). Such a number is a place for an agent's write with `basis`, as the index spelling is
    /// ([`KitCommand::index`]), when it names no object at `basis` or now; otherwise an id. Hosts
    /// mark the target parameter `"x-khp-index-numbers": true` (Kit Process Protocol section 6).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub index_numbers: bool,
    /// The command's effect on its target does not depend on where the target is (its index in
    /// its list, the fields its object model marks `position`, a clip's `start`): an opacity, a
    /// colour, a name. An agent's write with `basis` is then not refused when others only moved
    /// the target (its answer's `others` still says so). Off by default: a command that may
    /// depend on the target's position is refused when it moved. Hosts list it as
    /// `"x-khp-position": "independent"` at the top of the command's JSON Schema.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub position_independent: bool,
    /// Publish as required the parameters `params`' notation leaves without a default and does
    /// not mark optional ([`schema::Conversion::required`]), when [`KitCommand::with_kit_schema`]
    /// converts it. Off by default: many notations are imprecise (a key without `?` that the
    /// engine fills from the selection or a default), and a wrong `required` makes valid calls
    /// impossible. A kit turns it on command by command, or on every command it lists, once
    /// [`testing::check_required`] passes for those commands; hosts then refuse a call that leaves
    /// one out with `invalid-params` naming it, before the engine runs.
    #[serde(skip)]
    pub notation_required: bool,
}

/// Editor state a command may read besides its parameters ([`KitCommand::reads`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditorState {
    /// The selected objects (their ids), what `on` sets.
    Selection,
    /// The current part (slide, page), what `at.part` and the run's `target` set.
    Part,
    /// The current time of a timeline, in seconds, what `at.time` sets.
    Time,
    /// The editor's mode, which changes what a command does to the same objects: a 3D kit's edit
    /// mode (object, vertices, edges, faces), a document's editing mode (editing, suggesting). No
    /// call context sets it: a run sets it with the kit's own command in an earlier step, and the
    /// host puts it back after the call with the rest of the editor state.
    Mode,
    /// The active object new content goes to or a command applies to besides the selection: the
    /// active layer, the target tracks, the active object of a 3D scene (a spreadsheet's active
    /// sheet is its [`EditorState::Part`]). No call context sets it either: a run sets it with the
    /// kit's own command in an earlier step, and the host puts it back after the call.
    Active,
    /// The selected area: a region of pixels or of the canvas rather than objects (a photo kit's
    /// marquee, lasso or mask selection), which a fill, a cut or an adjustment confines itself to
    ///. Keep it in `editor_state` and in the kit's editor-state list (`/area`). No call
    /// context sets it: a run sets it with the kit's own command in an earlier step, and the host
    /// puts it back after the call.
    Area,
}

impl EditorState {
    /// The name hosts list in `x-khp-reads`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Selection => "selection",
            Self::Part => "part",
            Self::Time => "time",
            Self::Mode => "mode",
            Self::Active => "active",
            Self::Area => "area",
        }
    }
}

/// What one call acts on and where ([`KitDocument::set_context`], Kit Process Protocol
/// `context.set`): `on`, the ids of the objects a step acts on, as the kit's inspect lists them;
/// `part`, the part it acts in, as a run's `target` names it: one of the part nouns the kit's
/// manifest declares (`agent.parts`, for example `{"sequence": 12}` or `{"comp": "c3"}`), passed
/// as the call gave it, or for a kit that declares none `{"slide": 3}` counted from 1,
/// `{"slideId": 260}`, `{"page": 2}`, `{"pageId": 7}`; `time`, in seconds. An empty member is
/// not given and leaves that state as it is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallContext {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub on: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<f64>,
}

impl CallContext {
    /// Whether nothing is given.
    pub fn is_empty(&self) -> bool {
        self.on.is_empty() && self.part.is_none() && self.time.is_none()
    }

    /// The members given, by their protocol names (`on`, `part`, `time`).
    pub fn given(&self) -> Vec<&'static str> {
        [("on", !self.on.is_empty()), ("part", self.part.is_some()), ("time", self.time.is_some())]
            .into_iter()
            .filter_map(|(name, given)| given.then_some(name))
            .collect()
    }
}

/// What one call depends on ([`KitDocument::under`], Kit Process Protocol `context.under`): for a
/// command that names what it acts on by a place, the objects under that place now (by the ids
/// the kit's inspect lists) and where they sit in the lists the place falls in; for any call, the
/// premises the kit can state exactly.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Under {
    /// The objects a place names now; empty for a call that names its objects by id.
    pub objects: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub within: Vec<Within>,
    /// Order and membership among explicit objects in one list. Include every sibling whose
    /// order the result depends on; use `within` to also hold unlisted/new window members.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub orders: Vec<RelativeOrder>,
    /// What the call reads or replaces of each object it names ([`Premise`]): an object the call
    /// names (by id, by a place, or in a parameter) that no premise lists keeps the default, every
    /// field and every position.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub premises: Vec<Premise>,
    /// For a place no window can declare (a world point: what is there depends on geometry, the
    /// hierarchy and visibility), that the guard should ask the kit instead
    /// ([`KitDocument::covered`]): which objects were under the place at `basis`, given
    /// the values others changed since. Any declared `within` windows are checked as well.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub covers: Option<Covers>,
    /// Content read inside a field, independent of whole-field premises. Keep other
    /// fields in `premises`; the host asks `content_at` only after a relevant change.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub content: Vec<ContentPremise>,
    /// Names from `external_inputs` whose observed bytes this write consumes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<String>,
}

/// An external byte source observed by the kit; `None` means unavailable, never equal.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct ExternalInput {
    pub name: String,
    pub fingerprint: Option<String>,
}

/// A kit-defined sub-region of a field whose content the write relies on.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct ContentPremise {
    pub id: Value,
    pub field: String,
    pub region: Value,
}

/// The region question, with the complete field value reconstructed at basis.
#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct ContentAsk {
    #[serde(flatten)]
    pub premise: ContentPremise,
    pub before: Value,
    #[serde(flatten)]
    pub step: PremiseStep,
}

/// The zero-based run step and the state produced by its preceding steps. Callbacks run on
/// that isolated state; `changes` is the preceding steps' combined model change set.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct PremiseStep {
    #[serde(default)]
    pub step: usize,
    #[serde(default)]
    pub state: Value,
    #[serde(default)]
    pub changes: Value,
}

/// A place the kit tells by being asked ([`Under::covers`]): the fields besides the `position`
/// ones whose change may move an object into or out of the place (`hidden`, a mesh's derived
/// bounds `~bounds`). The guard asks [`KitDocument::covered`] about every object others created,
/// deleted, moved in a list, or changed in a position field (or a path inside one) or in one of
/// `fields` since `basis`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Covers {
    #[serde(default)]
    pub fields: Vec<String>,
}

/// One object a `context.covered` request asks about ([`KitDocument::covered`]): its id, the values
/// it had at `basis` of the fields that changed since (each the earliest value, a json field
/// rebuilt whole from the leaves a change set told), whether others deleted it since (`before`
/// then holds what the journal kept of it: its `position` fields and derived values), whether it
/// was created since (`created`: it was not there at `basis`, leave it out), and the fields whose
/// value at `basis` is not known (`unknown`: a change told without its value).
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct CoveredAsk {
    pub id: Value,
    #[serde(default)]
    pub before: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub created: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unknown: Vec<String>,
}

/// The kit's answer to `context.covered` ([`KitDocument::covered`]): what the place named at
/// `basis` (`under`, the objects as [`Under::objects`] names them now, evaluated with the objects'
/// values then), and for each object asked about whether it, or anything whose place derives
/// from it, was among them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct CoveredAt {
    pub under: Vec<Value>,
    pub covered: Vec<Covered>,
}

/// Immutable historical reads; `Err` means unavailable, never an empty blob.
pub trait HistoricalBlobs {
    /// Reads at most 1 MiB from a blob referenced at this call's basis.
    fn read(&self, hash: &str, offset: usize, length: usize) -> Result<Vec<u8>, String>;
}

/// The kit's answer for one [`CoveredAsk`]: whether the object, or anything whose place derives
/// from it (a child in a hierarchy), was under the place at `basis`; `None` when the kit cannot
/// say (a value it needs is `unknown`), which the guard reads as a refusal.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Covered {
    pub id: Value,
    pub covered: Option<bool>,
    /// The held object no longer exists, rather than having moved out of this place.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gone: bool,
    /// Optional content comparison at an unchanged place. Omit when occupancy alone matters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<CoveredContent>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoveredContent {
    Same,
    Changed,
    /// The held content was removed, while its containing object may still exist.
    Deleted,
    Unknown,
}

/// The derived values of one object ([`KitDocument::derived`], Kit Process Protocol `model.derived`):
/// by the names its type declares (`topology`), not stored anywhere.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct DerivedValues {
    pub id: Value,
    pub values: serde_json::Map<String, Value>,
}

/// What a change of one object carries with it that is no stored change ([`KitDocument::carried`],
/// Kit Process Protocol `model.carried`): a parent's move carries its descendants in world
/// space, a layer's shift its keys in comp time.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Carried {
    /// The object, by its tool id as the kit's inspect lists it.
    pub id: Value,
    pub carries: Carries,
}

/// How many objects or values a change carries, and what of them (`"world location"`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Carries {
    pub count: u64,
    pub what: String,
}

/// What one call reads or replaces of one object ([`Under::premises`]). An agent's write with
/// `basis` is refused as `changed` only for a change by others that touches one of `fields` (that
/// path, inside it, or a path holding it), and as `relocated` only for a change of one of
/// `positions`; a member left out (`None`) is every field, every position.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Premise {
    /// The object, by its tool id as the kit's inspect lists it.
    pub id: Value,
    /// Paths into the object, as receipts give them: its fields (`name`), paths into what it holds
    /// (`effects.1.params`, `sequence.captionTracks.0.captions.2`), or the same in the kit's words
    /// where the object model names held objects (`transform/opacity.keys.1`, receipts' `named`).
    /// `Some(vec![])`: no content of the object (only that it exists, and its `positions`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<String>>,
    /// Where the object is, as far as the call depends on it: fields its type marks `position`
    /// (`start`, `startTime`), and the list holding it by the field a change set names (`clips`,
    /// `comp.layers`) for its index there. `Some(vec![])`: the call does not depend on where the
    /// object is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub positions: Option<Vec<String>>,
    /// Stable member keys for selector fields (`channels[name="Alpha"]` -> `key`).
    /// Keys must be unique, immutable, present and retained across saved rereads. This lets
    /// the guard distinguish a selected entry's deletion from rename or name reassignment.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub identities: std::collections::BTreeMap<String, String>,
}

impl Premise {
    /// A premise on `id`: every field and position until narrowed.
    pub fn on(id: impl Into<Value>) -> Self {
        Self { id: id.into(), fields: None, positions: None, identities: std::collections::BTreeMap::new() }
    }

    /// Only these fields or paths.
    #[must_use]
    pub fn fields<S: Into<String>>(mut self, fields: impl IntoIterator<Item = S>) -> Self {
        self.fields = Some(fields.into_iter().map(Into::into).collect());
        self
    }

    /// Only these positions.
    #[must_use]
    pub fn positions<S: Into<String>>(mut self, positions: impl IntoIterator<Item = S>) -> Self {
        self.positions = Some(positions.into_iter().map(Into::into).collect());
        self
    }

    /// Identify entries of a declared selector field by this stable member key.
    #[must_use]
    pub fn identity(mut self, selector: impl Into<String>, member: impl Into<String>) -> Self {
        self.identities.insert(selector.into(), member.into());
        self
    }
}

/// A list a place falls in ([`Under::within`]): its object (`parent`, by its id as the object
/// model's change sets name it) and field. Either the window `[from, to)` of the indexes of the
/// items the place names now (for a place no item covers, `from == to`, where an item put there
/// would go), or, for a place in time in a list whose order is not time (a comp's layer stack) or
/// whose items say their time, `time`: then the guard tells exactly which items covered the place
/// after each change since `basis`, and `from` and `to` are not read.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Within {
    pub parent: Value,
    pub field: String,
    #[serde(default)]
    pub from: usize,
    #[serde(default)]
    pub to: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<TimeSpan>,
}

/// A relative list-order dependency. Index shifts and edits of unlisted siblings are irrelevant.
/// Object order in this declaration is immaterial; the guard compares their order in history.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct RelativeOrder {
    pub parent: Value,
    pub field: String,
    pub objects: Vec<Value>,
}

/// A place in time in a list ([`Within::time`]): the span `[from, to)` (a point when `from ==
/// to`), in the unit of the items' fields, and the fields of each item that say when it is: its
/// `start`, and its `end` or its `duration` (each a field its type marks `position`). An item
/// covers a point when `start <= from < end`, a span when it overlaps it. Numbers or numeric
/// strings (a tick count).
/// With neither `end` nor `duration`, each member is a point at `start`: include it
/// when `from <= start < to`, or `start == from` for a point window.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct TimeSpan {
    /// Stable member identity for JSON-array windows. Missing or duplicate identities refuse
    /// unknown; without this member, ordering values identify entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    pub from: Value,
    pub to: Value,
    pub start: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<String>,
}

/// Top-level `inspect()` keys that are the editing session's bookkeeping in every kit: its undo
/// history and saved state (which a host reports itself), and the file's path and title. Only the
/// top level's: a document field of the same name deeper in (a guide's `history`, a layer's `path`)
/// is the document's.
pub const SESSION_KEYS: &[&str] = &["canUndo", "canRedo", "dirty", "revision", "history", "redo", "undo", "path", "title"];

/// What `inspect()` says of the document itself: `inspected` without the session's bookkeeping
/// ([`SESSION_KEYS`], at the top) and without the editor state the kit declares (`editor_state`,
/// kition-headless's volatile keys): a name is left out wherever it is, a JSON Pointer (`/time`,
/// `/view/zoom`) only at that place. No key is left out for its name alone: the selection, the
/// current time or the playhead are editor state only when the kit says so, and a keyframe's
/// `time` or an animated property's `path` stays. kition-headless's `view.describe` answers it,
/// and [`testing::check_context`] compares it.
pub fn document_content<S: AsRef<str>>(inspected: Value, editor_state: &[S]) -> Value {
    let (pointers, names): (Vec<&str>, Vec<&str>) = editor_state.iter().map(AsRef::as_ref).partition(|key| key.starts_with('/'));
    let mut value = without_names(inspected, &names);
    if let Value::Object(map) = &mut value {
        map.retain(|key, _| !SESSION_KEYS.contains(&key.as_str()));
    }
    for pointer in pointers {
        let Some((parent, key)) = pointer.rsplit_once('/') else { continue };
        let key = key.replace("~1", "/").replace("~0", "~");
        if let Some(Value::Object(map)) = if parent.is_empty() { Some(&mut value) } else { value.pointer_mut(parent) } {
            map.remove(&key);
        }
    }
    value
}

/// `value` without the keys `names`, at any depth.
fn without_names(value: Value, names: &[&str]) -> Value {
    match value {
        Value::Object(map) => {
            Value::Object(map.into_iter().filter(|(key, _)| !names.contains(&key.as_str())).map(|(key, value)| (key, without_names(value, names))).collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(|item| without_names(item, names)).collect()),
        other => other,
    }
}

impl KitCommand {
    /// Fills `schema` from `params` written in kit command notation, when it converts
    /// ([`schema::from_kit_params`]); otherwise leaves it empty, which keeps the command off
    /// agents' tool lists. With [`KitCommand::notation_required`] the parameters the notation leaves
    /// without a default and not optional are marked required ([`schema::Conversion::required_schema`]).
    #[must_use]
    pub fn with_kit_schema(mut self) -> Self {
        if self.schema.is_none() {
            let required = self.notation_required;
            self.schema = self
                .params
                .as_deref()
                .and_then(|params| schema::from_kit_params(params).ok())
                .map(|converted| if required { converted.required_schema() } else { converted.schema });
        }
        self
    }
}

/// An owned, format-specific value settling step run inside a model batch transaction.
#[cfg(feature = "session")]
pub type BatchSettler = Box<dyn Fn(&mut kdm::Tx<'_>) -> Result<(), String>>;

#[cfg(feature = "session")]
pub type ValueLimits = kdm::batch::ValueLimits;

/// One open document of a kit's engine. Errors are plain messages; they never panic, because a
/// panic stops the worker the document lives in.
pub trait KitDocument: Sized {
    /// Complete objects computed from the current document, using their public ids.
    /// Required only when the schema declares projected types; never mutate the replica here.
    #[cfg(feature = "session")]
    fn projected_objects(&self) -> Result<Vec<kdm::projection::ProjectedObject>, String> {
        Err("this kit cannot read its declared projected objects".into())
    }
    /// Conditional numeric limits. The callback receives `{id,type,fields}` and a concrete
    /// field/member path, with this transaction's earlier writes already applied.
    /// Return an owned callback; it must be deterministic and must not change the document.
    #[cfg(feature = "session")]
    fn value_limits(&self) -> Option<ValueLimits> {
        None
    }
    /// Refreshes kit-owned caches after each committed run of model operations, on both
    /// direct-session and exchange paths. Runs before a following command, even if it fails.
    /// Read-only batches and rolled-back transactions do not call it. Makes no document edit.
    fn batch_applied(&mut self) {}

    /// Selects value settling for model batches (for example PSD byte opacity). The closure
    /// owns its configuration and runs after the model operations, before the same transaction
    /// commits. A failure rolls that transaction back. Reads do not call it.
    #[cfg(feature = "session")]
    fn batch_settler(&self) -> Option<BatchSettler> {
        None
    }
    /// Opens file bytes; `name`'s extension picks the format.
    fn open(name: &str, bytes: &[u8]) -> Result<Self, String>;
    /// A new, empty document.
    fn create(name: &str, width: u32, height: u32) -> Result<Self, String>;
    /// The document's size in document pixels.
    fn width(&self) -> u32;
    fn height(&self) -> u32;
    /// One line on what the document is, for agents and hosts: its size by default. A kit whose
    /// document pixels are not the document's own size (slides on a canvas with margins) says so.
    fn summary(&self) -> String {
        format!("{} × {}", self.width(), self.height())
    }
    /// The bands that stay in view while the rest scrolls, in document pixels: the columns left of
    /// `left` and the rows above `top` (a sheet's headings and frozen panes). None by default.
    fn pinned(&self) -> (u32, u32) {
        (0, 0)
    }
    /// Moves with every change.
    fn revision(&self) -> u64;
    /// Unsaved changes exist.
    fn dirty(&self) -> bool;
    /// Straight-alpha RGBA8 of the area at (`x`, `y`) shown at `scale` screen pixels per document
    /// pixel, `width` × `height` large. Below 1 the area is averaged; above 1 pixels repeat exactly.
    fn render(&self, x: f64, y: f64, scale: f64, width: u32, height: u32) -> Result<Vec<u8>, String>;
    /// RGBA8 of the integer area (`x0`, `y0`)–(`x1`, `y1`) averaged down to exactly `width` ×
    /// `height`. When the area is k times the size, each output pixel is the exact k × k box mean;
    /// Kition patches its cached frame with this and relies on it matching a full render.
    fn render_area(&self, x0: i32, y0: i32, x1: i32, y1: i32, width: u32, height: u32) -> Result<Vec<u8>, String>;
    /// The largest scale at which [`KitDocument::render`] draws the document as the person would
    /// see it at that zoom, not its 1× pixels repeated: an engine that rasterizes vectors and text
    /// at the scale it is given answers 2 or more, and so may a pixel editor, whose document pixels
    /// are what a zoom shows. 1 by default. A headless kit's `view.screenshot` (Kit Process Protocol
    /// section 7, KHP A39) draws previews up to this scale and refuses a larger one rather than
    /// answer an enlarged 1× image.
    fn max_render_scale(&self) -> f64 {
        1.0
    }
    /// Runs a command; unknown commands and bad parameters are errors.
    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String>;
    /// The document as JSON. It must include `canUndo` and `canRedo`; the rest is the kit's own.
    fn inspect(&self) -> Result<Value, String>;
    /// Every command, including `edit.undo` and `edit.redo`.
    fn commands(&self) -> Vec<KitCommand>;
    /// The ids of the commands that cannot run now. Hosts ask after every change to keep menus
    /// and shortcuts current, so engines whose [`KitDocument::commands`] is heavy (it carries
    /// parameter schemas) should answer this directly; the default derives it from `commands()`.
    fn disabled_commands(&self) -> Vec<String> {
        self.commands().into_iter().filter(|command| !command.enabled).map(|command| command.id).collect()
    }
    /// The document as file bytes, in `name`'s format or the document's own. It must not mark the
    /// document saved: the host writes the bytes and then calls [`KitDocument::mark_saved`].
    fn save(&self, name: Option<&str>) -> Result<Vec<u8>, String>;
    /// Records that the bytes from the last [`KitDocument::save`] reached the file.
    fn mark_saved(&mut self);
    /// The document exported as file bytes in `format`, an extension of the manifest's `exports`
    /// (Kit Process Protocol `document.export`, KHP A41), for example `mp4` from a motion graphics
    /// project. It must not change the document. The host writes the bytes to a new file. None
    /// by default: every format is an error.
    fn export(&self, format: &str, _options: &Value) -> Result<Vec<u8>, String> {
        Err(format!("this kit does not export {format}"))
    }
    /// The extensions [`KitDocument::export`] writes. Hosts offer an export only for formats the
    /// manifest's `exports` lists and this returns, so a kit that declares an export its engine
    /// cannot write headless does not offer it. None by default.
    fn exports() -> Vec<&'static str> {
        Vec::new()
    }
    /// What is wrong with the document (standard 2.0 A21): broken references, overflowing text,
    /// formula errors. It must not change the document (neither revision nor dirty state) and
    /// should be quick enough to run after every agent step. None by default.
    fn check(&self) -> Vec<diagnostics::Diagnostic> {
        Vec::new()
    }
    /// The next chunk of a file a command produced (engine contract E16), at most `max` bytes (all that is
    /// left when `None`). A command that makes files answers their [`outputs::OutputInfo`]s and
    /// keeps the bytes until the host takes them; the call that takes the last byte forgets the
    /// output. [`outputs::Outputs::take`] does exactly this. None by default: every id is an error.
    fn take_output(&mut self, id: &str, _max: Option<usize>) -> Result<Vec<u8>, String> {
        Err(format!("there is no output {id}"))
    }
    /// The document's words as plain text in reading order, at most `limit` Unicode scalar values
    /// (`KitText 1.0`, the Kit Process Protocol's `document.text`). Build it with
    /// [`text::TextBuilder`]. It must not change the document (neither revision nor dirty state)
    /// and holds no markup, formulas, hidden or deleted content. Served only for a kit whose
    /// manifest lists the capability [`text::CAPABILITY`]; [`testing::check_text`] proves it.
    /// None by default: an error.
    fn text(&self, _limit: usize) -> Result<text::DocumentText, String> {
        Err("this kit does not answer document.text".into())
    }
    /// Told once, right after the document is opened or created, how a host runs it (engine
    /// contract E22): with [`host::Hosting::files_only`] the engine reaches no file by path,
    /// starts no process, opens no network connection and scans no system fonts; everything goes
    /// through [`host`] and [`outputs`]. [`host::hosting`] says the same before the document
    /// exists. Whom each call is for is [`dispatch::role`]. Nothing by default: the page's
    /// worker never calls it.
    fn hosted(&mut self, _hosting: &host::Hosting) {}
    /// A snapshot of the editor state that is not the document (the selection, the current part,
    /// the current time, a mode), opaque to hosts, which hand it back to
    /// [`KitDocument::restore_editor_state`]. A host saves it before an agent's call and restores
    /// it after, so no call leaves hidden state behind. It must not change the document. `Null`
    /// by default: a kit that keeps no such state, or keeps it from no host.
    fn editor_state(&self) -> Value {
        Value::Null
    }
    /// Puts back a snapshot [`KitDocument::editor_state`] answered. Like
    /// [`KitDocument::set_context`], it must not mark the document dirty, move `revision()`, or
    /// enter the undo history. By default only `Null` is taken back.
    fn restore_editor_state(&mut self, saved: &Value) -> Result<(), String> {
        if saved.is_null() { Ok(()) } else { Err("this kit keeps no editor state to restore; it is not available".into()) }
    }
    /// Sets the editor state one command reads ([`KitCommand::reads`]) from what the call says it
    /// acts on: the selection from `context.on`, the current part from `context.part`, the
    /// current time from `context.time`. It must not mark the document dirty, move
    /// `revision()`, or enter the undo history, and must refuse an id or part the document does not
    /// have. By default every given member is refused, named.
    fn set_context(&mut self, context: &CallContext) -> Result<(), String> {
        if context.is_empty() {
            return Ok(());
        }
        Err(format!(
            "setting the editor context ({}) is not available in this kit: it implements no KitDocument::set_context",
            context.given().iter().map(|name| format!("`{name}`")).collect::<Vec<_>>().join(", ")
        ))
    }
    /// What command `command` with `params` depends on ([`Under`], Kit Process Protocol
    /// `context.under`): for a command that names what it acts on by a place
    /// ([`KitCommand::places`], an index spelling, or the current time for a command that reads
    /// it), the objects under that place now and the windows of the lists they are in; and for any
    /// call, by id too, the [`Premise`]s the kit can state exactly (which fields of an object it
    /// reads or replaces, which of its positions it depends on). The host has set the step's part
    /// and time ([`KitDocument::set_context`]) before it asks, and puts the editor state back
    /// after; it must not change the document. An agent's write with `basis` is checked with it,
    /// and the host asks for every step of such a write: for a step that names its
    /// objects by id, only `premises` is read. `None` (the default) for a command or a kit that
    /// cannot say: a step by place is then refused after any change by others that moved, created
    /// or deleted objects, and a step by id keeps every field and position of its objects.
    fn under(&self, _command: &str, _params: &Value) -> Result<Option<Under>, String> {
        Ok(None)
    }

    fn under_step(&self, command: &str, params: &Value, _step: &PremiseStep) -> Result<Option<Under>, String> {
        self.under(command, params)
    }

    /// An isolated copy with identical object identities, blob access and document content.
    /// The host restores editor state on the copy and discards it after planning. No file may
    /// be written by this hook. A kit without a copy refuses dependent stale runs as unknown.
    fn fork_for_premises(&self) -> Result<Self, String>
    where
        Self: Sized,
    {
        Err("this kit cannot fork its document for premise planning".into())
    }
    /// Addressed ids or names whose identity cannot be proven across a saved-file reread.
    /// Return only values from `objects`. The host consults this after an outside change
    /// since basis; a fresh observation establishes a new basis. No document state may change.
    fn unproven_identities(&self, _objects: &[Value]) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
    /// Called on the freshly read document before replacing a live session. Inspect each
    /// replica-only object in `previous` and keep it, re-anchor it, or leave it dropped.
    /// Preserve kept object identities; do not copy stale file content. An error keeps the
    /// previous session intact. The default carries nothing.
    fn carry_replica_objects(&mut self, _previous: &Self) -> Result<(), String> {
        Ok(())
    }
    /// Reconciles a clean session with freshly read file content without replacing its undo
    /// histories. Return true after applying only the file difference to this session, with
    /// import origin, preserving identities, editor state and retained blobs. Return false
    /// without changing anything when unsupported. An error must also leave this session
    /// intact. The host validates the saved editor state on `fresh` before calling this hook
    /// and marks a reconciled session saved. Explicit reload of unsaved edits discards them.
    fn reconcile_reread(&mut self, _fresh: &Self) -> Result<bool, String> {
        Ok(false)
    }
    /// Current fingerprints of named external inputs exposed by observations of this document.
    /// Return a stable content fingerprint, and retain unavailable names with `None`.
    fn external_inputs(&self) -> Result<Vec<ExternalInput>, String> {
        Ok(Vec::new())
    }
    /// What the place `command` with `params` names was at the agent's `basis` (Kit Process Protocol
    /// `context.covered`): asked for a place whose [`Under::covers`] the kit gave, with
    /// the step's part and time set as for [`KitDocument::under`]. Evaluate the place as it was:
    /// every object of `objects` with its [`CoveredAsk::before`] values put in at once (a deleted
    /// one put back from what `before` holds, a created one left out), every other object as it is
    /// now, in the kit's own geometry query, without changing the document or the editor state.
    /// Answer [`CoveredAt::under`], what the place names in that state, and for each object
    /// whether it, or anything whose place derives from it (its children), is among them
    /// ([`Covered::covered`], `None` for one whose needed values are `unknown`). `None` (the
    /// default): the kit cannot say, and the guard refuses the write by that place after any such
    /// change.
    fn covered(&self, _command: &str, _params: &Value, _objects: &[CoveredAsk]) -> Result<Option<CoveredAt>, String> {
        Ok(None)
    }
    /// Opt into host capture before a reload can discard this session's blobs.
    #[cfg(feature = "session")]
    fn blob_source(&self) -> Option<&dyn session::BlobSource> {
        None
    }
    /// Like `covered`, with immutable bytes authorized only for this call's basis.
    /// Missing bytes must produce `covered: None`, never a negative hit test.
    fn covered_at(&self, command: &str, params: &Value, objects: &[CoveredAsk], _history: &dyn HistoricalBlobs) -> Result<Option<CoveredAt>, String> {
        self.covered(command, params, objects)
    }

    fn covered_step(
        &self,
        command: &str,
        params: &Value,
        objects: &[CoveredAsk],
        history: &dyn HistoricalBlobs,
        _step: &PremiseStep,
    ) -> Result<Option<CoveredAt>, String> {
        self.covered_at(command, params, objects, history)
    }
    /// Whether content inside the region differs from `before`. `None` means cannot
    /// say and refuses `unknown`; this must not change the document or editor state.
    fn content_at(&self, _ask: &ContentAsk, _history: &dyn HistoricalBlobs) -> Result<Option<bool>, String> {
        Ok(None)
    }
    /// The derived values `names` (every one its type declares when empty) of the objects `ids`
    /// (every object of a type that declares derived values when empty), by the ids the inspect
    /// lists (Kit Process Protocol `model.derived`): computed from the document as it is
    /// now, small (a count, a hash, a bounds pair), never stored. An object without a tool id (the
    /// root: a photo's `Image`) is asked and answered by its object id, as a load answers its `id`
    /// and change sets name it; give the root the same object id on every read of the
    /// file (`Tx::create_with_id`), so that a change made in the file names it too. The default
    /// answers none.
    fn derived(&self, _ids: &[Value], _names: &[String]) -> Result<Vec<DerivedValues>, String> {
        Ok(Vec::new())
    }

    /// For the objects `ids` a change set names (asked once per change set), what each
    /// change carries with it that is no stored change: a parent's move its descendants (`{ count:
    /// 200, what: "world location" }`), a layer's shift its keys in comp time. Read with the
    /// document as it is after the change; answer only the objects whose change carries something.
    /// Receipts, `others` and the journal show it on the object's change as `carries`. The default
    /// answers none. `changes` contains the changed/moved entries, including `fields`, `edits`
    /// and `from`/`to`; inspect them to distinguish a rename from a transform or timing change.
    fn carried(&self, _ids: &[Value], _changes: &[Value]) -> Result<Vec<Carried>, String> {
        Ok(Vec::new())
    }
}

/// Parses command parameters from JavaScript: an empty string is `{}`.
pub fn parse_params(params: &str) -> Result<Value, String> {
    if params.trim().is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    serde_json::from_str(params).map_err(|error| format!("params are not JSON: {error}"))
}

/// `editorState()` for the page (C3b): [`KitDocument::editor_state`] as JSON text, `null` for a
/// kit that keeps none.
#[doc(hidden)]
pub fn __editor_state<D: KitDocument>(document: &D) -> String {
    document.editor_state().to_string()
}

/// `restoreEditorState(state)` for the page: puts back what [`__editor_state`] answered.
#[doc(hidden)]
pub fn __restore_editor_state<D: KitDocument>(document: &mut D, state: &str) -> Result<(), String> {
    let state: Value = serde_json::from_str(state).map_err(|error| format!("the editor state is not JSON: {error}"))?;
    document.restore_editor_state(&state)
}

/// `setContext(context)` for the page: the call context `{on?, part?, time?}` as JSON text, as the
/// headless host's `context.set` takes it.
#[doc(hidden)]
pub fn __set_context<D: KitDocument>(document: &mut D, context: &str) -> Result<(), String> {
    let context: CallContext = serde_json::from_str(context).map_err(|error| format!("the call context is not `{{on?, part?, time?}}`: {error}"))?;
    document.set_context(&context)
}

/// The commands as the JSON string the JavaScript interface returns.
#[doc(hidden)]
pub fn __serde_json_string(ids: &[String]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_owned())
}

pub fn commands_json(commands: &[KitCommand]) -> String {
    serde_json::to_string(commands).unwrap_or_else(|_| "[]".to_owned())
}

#[doc(hidden)]
#[cfg(target_arch = "wasm32")]
pub use wasm_bindgen as __wasm_bindgen;

/// The SDK's wasm-bindgen, for a kit's own extras on the exported class, so the kit does not
/// depend on wasm-bindgen itself:
///
/// ```ignore
/// #[cfg(target_arch = "wasm32")]
/// mod web {
///     use kition_kit::wasm_bindgen::prelude::*;
///
///     use crate::__kition_kit_export::WebDocument;
///
///     #[wasm_bindgen(js_class = "SketchDocument", wasm_bindgen = kition_kit::wasm_bindgen)]
///     impl WebDocument {
///         #[wasm_bindgen(js_name = strokeCount)]
///         pub fn stroke_count(&self) -> u32 {
///             self.0.stroke_count()
///         }
///     }
/// }
/// ```
///
/// Kition reaches extras with `KitEngine.invoke(name,...args)`.
#[cfg(target_arch = "wasm32")]
pub use wasm_bindgen;

/// Exports a [`KitDocument`] to JavaScript as the class Kition loads, with exactly the members of
/// the kit engine contract: `open`, `create`, `width`, `height`, `revision`, `dirty`, `render`,
/// `renderArea`, `execute`, `inspect`, `commands`, `save`, `markSaved`, `check`, `takeOutput`, and
/// `contractVersion`.
///
/// `export_kit_document!(PhotoDocument as "PhotoDocument")` defines
/// `__kition_kit_export::WebDocument`, a wrapper with the document in `.0`; add the kit's own
/// extras in another `impl` block on it with `#[wasm_bindgen(js_class = "PhotoDocument")]`. It expands to nothing outside `wasm32`, so the
/// kit's native tests build without wasm-bindgen.
#[macro_export]
macro_rules! export_kit_document {
    ($document:ident as $js_name:literal) => {
        $crate::__export_kit_document_paste!($document, $js_name);
    };
}

#[doc(hidden)]
#[macro_export]
#[cfg(not(target_arch = "wasm32"))]
macro_rules! __export_kit_document_paste {
    ($document:ident, $js_name:literal) => {};
}

#[doc(hidden)]
#[macro_export]
#[cfg(target_arch = "wasm32")]
macro_rules! __export_kit_document_paste {
    ($document:ident, $js_name:literal) => {
        #[doc(hidden)]
        pub mod __kition_kit_export {
            use super::$document;
            // wasm-bindgen's generated code names the crate `wasm_bindgen`; the kit need not
            // depend on it, so the SDK's copy answers to that name here.
            use $crate::__wasm_bindgen as wasm_bindgen;
            use $crate::__wasm_bindgen::prelude::*;
            use $crate::KitDocument as _;

            fn error(message: String) -> JsError {
                JsError::new(&message)
            }

            #[wasm_bindgen(js_name = $js_name, wasm_bindgen = $crate::__wasm_bindgen)]
            pub struct WebDocument(pub(crate) $document);

            #[wasm_bindgen(js_class = $js_name, wasm_bindgen = $crate::__wasm_bindgen)]
            impl WebDocument {
                pub fn open(name: &str, bytes: &[u8]) -> Result<WebDocument, JsError> {
                    <$document as $crate::KitDocument>::open(name, bytes).map(Self).map_err(error)
                }

                pub fn create(name: &str, width: u32, height: u32) -> Result<WebDocument, JsError> {
                    <$document as $crate::KitDocument>::create(name, width, height).map(Self).map_err(error)
                }

                #[wasm_bindgen(js_name = contractVersion)]
                pub fn contract_version() -> u32 {
                    $crate::CONTRACT_VERSION
                }

                #[wasm_bindgen(getter)]
                pub fn width(&self) -> u32 {
                    $crate::KitDocument::width(&self.0)
                }

                #[wasm_bindgen(getter)]
                pub fn height(&self) -> u32 {
                    $crate::KitDocument::height(&self.0)
                }

                #[wasm_bindgen(getter, js_name = pinnedLeft)]
                pub fn pinned_left(&self) -> u32 {
                    $crate::KitDocument::pinned(&self.0).0
                }

                #[wasm_bindgen(getter, js_name = pinnedTop)]
                pub fn pinned_top(&self) -> u32 {
                    $crate::KitDocument::pinned(&self.0).1
                }

                #[wasm_bindgen(getter)]
                pub fn revision(&self) -> u64 {
                    $crate::KitDocument::revision(&self.0)
                }

                #[wasm_bindgen(getter)]
                pub fn dirty(&self) -> bool {
                    $crate::KitDocument::dirty(&self.0)
                }

                pub fn render(&self, x: f64, y: f64, scale: f64, width: u32, height: u32) -> Result<Vec<u8>, JsError> {
                    $crate::KitDocument::render(&self.0, x, y, scale, width, height).map_err(error)
                }

                #[wasm_bindgen(js_name = renderArea)]
                pub fn render_area(&self, x0: i32, y0: i32, x1: i32, y1: i32, width: u32, height: u32) -> Result<Vec<u8>, JsError> {
                    $crate::KitDocument::render_area(&self.0, x0, y0, x1, y1, width, height).map_err(error)
                }

                pub fn execute(&mut self, command: &str, params: &str) -> Result<String, JsError> {
                    let params = $crate::parse_params(params).map_err(error)?;
                    $crate::KitDocument::execute(&mut self.0, command, params).map(|value| value.to_string()).map_err(error)
                }

                pub fn inspect(&self) -> Result<String, JsError> {
                    $crate::KitDocument::inspect(&self.0).map(|value| value.to_string()).map_err(error)
                }

                pub fn commands(&self) -> String {
                    $crate::commands_json(&$crate::KitDocument::commands(&self.0))
                }

                /// The ids of the commands that cannot run now, as a JSON array.
                #[wasm_bindgen(js_name = disabledCommands)]
                pub fn disabled_commands(&self) -> String {
                    $crate::__serde_json_string(&$crate::KitDocument::disabled_commands(&self.0))
                }

                pub fn save(&self, name: Option<String>) -> Result<Vec<u8>, JsError> {
                    $crate::KitDocument::save(&self.0, name.as_deref()).map_err(error)
                }

                #[wasm_bindgen(js_name = markSaved)]
                pub fn mark_saved(&mut self) {
                    $crate::KitDocument::mark_saved(&mut self.0);
                }

                /// `{ "diagnostics": [...] }` as JSON (standard 2.0 A21).
                pub fn check(&self) -> String {
                    $crate::diagnostics::report(&$crate::KitDocument::check(&self.0)).to_string()
                }

                /// The next chunk of output `id`, at most `max` bytes (engine contract E16).
                #[wasm_bindgen(js_name = takeOutput)]
                pub fn take_output(&mut self, id: &str, max: Option<u32>) -> Result<Vec<u8>, JsError> {
                    $crate::KitDocument::take_output(&mut self.0, id, max.map(|max| max as usize)).map_err(error)
                }

                /// The editor state that is not the document, as JSON (`KitDocument::editor_state`):
                /// an editor puts the person's aside while an agent's step runs in the agent's own.
                #[wasm_bindgen(js_name = editorState)]
                pub fn editor_state(&self) -> String {
                    $crate::__editor_state(&self.0)
                }

                /// Puts back what `editorState()` answered (`KitDocument::restore_editor_state`).
                #[wasm_bindgen(js_name = restoreEditorState)]
                pub fn restore_editor_state(&mut self, state: &str) -> Result<(), JsError> {
                    $crate::__restore_editor_state(&mut self.0, state).map_err(error)
                }

                /// Sets the editor state one command reads from a call context `{on?, part?, time?}` as
                /// JSON (`KitDocument::set_context`).
                #[wasm_bindgen(js_name = setContext)]
                pub fn set_context(&mut self, context: &str) -> Result<(), JsError> {
                    $crate::__set_context(&mut self.0, context).map_err(error)
                }

                #[wasm_bindgen(js_name = premiseRead)]
                pub fn premise_read(&self, method: &str, params: &str) -> Result<String, JsError> {
                    let params = $crate::parse_params(params).map_err(error)?;
                    $crate::premise::read(&self.0, method, &params).map(|value| value.to_string()).map_err(error)
                }

                #[wasm_bindgen(js_name = forkForPremises)]
                pub fn fork_for_premises(&self) -> Result<WebDocument, JsError> {
                    $crate::KitDocument::fork_for_premises(&self.0).map(WebDocument).map_err(error)
                }
            }
        }
    };
}
