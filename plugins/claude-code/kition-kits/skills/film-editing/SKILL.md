---
name: film-editing
description: "Create, inspect, edit and check a video project (.kfilm) with the Kition Film kit's tools: clips, the timeline, trimming, transitions, titles, audio, and more. Use when the user asks to make, read, change, review or fix .kfilm files in this project."
---

<!-- Generated from kition-film agent/guide.md by kition-sdk tools/agent-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (its "unified" option): the
`film_<action>` tools this guide names are `kit_<action>`, routed by the file's extension
(`film_run` is `kit_run`, `film_check` is `kit_check`). With "unified" off they are named as
written. Paths are relative to the project folder.

# Film kit

The Film kit opens, edits and checks video projects (`.kfilm`) with Premiere Pro's commands. An agent
can make and import project items, place clips on a sequence's tracks, trim, split and close gaps,
add transitions, titles and captions, lay music and sound effects on the beat, and check the project
for missing or offline media, gaps and empty sequences.

## Tools

The kit's prefix is `film`. Its tools are:

| Tool | Does |
|---|---|
| `film_inspect` | The project as JSON (its items, the open sequence's tracks and clips); with `preview: true`, a frame or a contact sheet of frames |
| `film_query` | Reads objects of the project's object model by id, or by following fields from the root |
| `film_commands` | Finds commands by keywords, each with its parameter schema |
| `film_run` | Runs a list of command steps |
| `film_batch` | Runs one batch of object-model operations |
| `film_check` | What is wrong with the project, as diagnostics |
| `film_create` | Makes a new `.kfilm` project |
| `film_draft_ready`, `film_draft_reopen` | Asks the person to review your draft, or takes it back to edit |

Every tool takes `path`, the project's path in the workspace. With `draft: true` your edits go to
your draft of the project and leave the file as it is; only the person merges or discards a draft.
The object model's types are the project's `Project`, `Bin`, `Item`, `Sequence`, `Track`, `Clip`,
`Effect` and `Transition`. The kit has no `film_export`.

## Addressing and coordinates

- A project holds **items**: media (footage, stills, generators such as colour mattes), sequences
  and subclips. `film_inspect` answers them as `details.project.root.children`, each with its `item`
  id, `name`, `type` (`Sequence`, `Synthetic`, `Movie`, …) and `duration`.
- `details.sequence` is the **open sequence**, the one timeline commands act on
  ([`sequence.open`](/kits/film/commands/sequence.open/) `{ "item": 12 }` opens another), with its
  `id`, its video tracks (`V1`, `V2`, …) and audio tracks (`A1`, …). Each track lists its clips
  (`items`), each with a clip id, its project `item`, `start` and `duration`.
- Apart from which sequence is open, the details are the document alone: the playhead, the
  selection and other editor state are not in them, and moving the playhead changes nothing you
  read. Keyframe `time`s are the document's and are there.
- **Ids:** bins, items, tracks, clips, transitions, markers and captions have numeric ids, from
  one counter for the whole project, so each number names one thing. Commands answer the ids they
  make ([`item.newColorMatte`](/kits/film/commands/item.newColorMatte/) → `{ "item": 8 }`,
  [`timeline.place`](/kits/film/commands/timeline.place/) → `{ "clips": [9] }`). The file keeps
  them: they are the same after a save, a reopen, or another program rewriting the project.
  A write's `changes`, `others` and `conflicts` name a bin, item, track, clip or transition by the
  same number (`9`, with its `type`); `film_query` and `film_batch` give it as a string (`"9"`).
  `on` takes either; a command's own id parameter (`clip`, `clips`, `item`) takes the number only
  and refuses the string.
- **Tracks** are named `V1`, `V2`, … and `A1`, `A2`, … in commands, counted from **1**. Their
  display names ("Video 1") are not accepted. Clip and transition lists are chronological:
  change their start times to move them; changing list order alone is repaired without an edit.
- **Time** runs from 0 at the start of the sequence. Times in the project are **ticks**,
  254,016,000,000 per second. How a time is spelled:

  | Spelling | Unit | Where |
  |---|---|---|
  | `time`, `duration`, `sourceIn`, `delta`, `mediaTime`, `start`/`end` in a command | ticks | most timeline commands; `mediaTime` is the clip's media time |
  | `seconds`, `startSeconds`, `endSeconds` | seconds | where the schema offers them ([`timeline.place`](/kits/film/commands/timeline.place/) `{ "seconds": 2 }`) |
  | `frame`, `startFrame`, `durationFrames`, `deltaFrames`, `fadeInFrames`, … | frames of the sequence, from **0** | where the schema offers them |
  | `timecode` | `HH:MM:SS:FF` of the sequence | where the schema offers it |
  | a step's `at.time` | seconds | any step (see [Steps](#steps-on-and-at)) |
  | a preview's `target.time`, `target.range`; caption word times | seconds | `film_inspect`, `caption.add` |
  | diagnostics and their fixes | ticks | pass them on unchanged |

  Use seconds where the schema offers them. A command whose optional `time` defaults to the
  playhead ([`timeline.razor`](/kits/film/commands/timeline.razor/),
  [`marker.add`](/kits/film/commands/marker.add/),
  [`effect.addKeyframe`](/kits/film/commands/effect.addKeyframe/), the mixer and multicam
  commands, …) takes seconds as the step's `at.time`. Some take ticks only: `sequence.closeGap`'s
  `time`, `timeline.move`'s `moves[].time`, `timeline.place`'s `sourceIn` and `duration`,
  `timeline.rateStretch`'s `delta`, the keyframe commands' `mediaTime` and `to`,
  `mixer.deleteKeyframe` and `mixer.moveKeyframe`'s `time` and `newTime`, and
  `project.setMarks`'s `in` and `out`.
- A sequence renders what its tracks hold at each moment. A preview shows the sequence and the
  time you name (see [Previews](#previews)); it never depends on the playhead or on which sequence
  is open.

## Workflow

1. `film_inspect` for the items and the sequence's tracks and clips; add `preview: true` to see it.
2. Find the command: `film_commands` with specific words (`place clip`, `color matte`, `split`,
   `close gap`, `cross dissolve`). Use the exact id it returns and follow its parameter schema;
   never guess a command id.
3. `film_run` a few steps at a time. A step can't use an earlier step's answer: run the step that
   makes an item, read its id from the answer, then run the step that uses it. Name what each
   step acts on and when (see [Steps](#steps-on-and-at)); never move the playhead or select
   clips first just to aim a command.
4. `film_check`, then fix what it reports.
5. `film_inspect` again to confirm the tracks and clips, and look at the frames you changed
   (`preview: true` with a `target.time`).

## Steps: on and at

A `film_run` step is `{ "command", "params"?, "on"?, "at"? }`:

- **`at.time`** is seconds from the start of the step's sequence: the playhead is set there for
  the step (on the start of the frame showing that time: at 23.976 fps, 3.5 s is frame 83, at
  3.4618 s). It must lie from 0 to the sequence's end, both included; else the step is refused
  with the range. Commands that act at the playhead act there.
- **`on`** lists the ids the step acts on, as `film_inspect` lists them: clip ids (`clip`, also
  captions) of the step's sequence, or project item ids (`item`). Ids come from one counter for
  the whole project, so each names one thing. A command with a `clips`, `clip`, `items` or `item`
  parameter gets them there (one id for `clip` and `item`); a command that acts on the selection
  acts on exactly these. An id the sequence or the project lacks is refused, saying where valid
  ids come from; a clip of another sequence names that sequence.
- **`at.part`** names the step's sequence, `{ "sequence": <item id> }` as `file.render`'s
  `target.sequence` does; a run's `target` and an inspect's `target` take the same. The step acts
  in that sequence, and the open sequence is put back afterwards.
- After the run, and after a failed run is rolled back, the open sequence, the playheads, the
  Source monitor, the track targets and the selections are what they were before it. A command
  you give its clips, item or time leaves them as they were even inside the run, unless moving
  them is its work (`playhead.*`, `sequence.open`, `timeline.select`, `project.select`,
  `source.open`, …).
- **Counting:** tracks `V1`, `A1` from 1; frames from 0; `at.time` and preview times in seconds
  from 0; ids are not counted, they are the ids `film_inspect` answers.

Each command's schema says what it acts on (`x-khp-role: targets` on its id parameter) and what
it reads besides its parameters (`x-khp-reads`: `selection`, `part`, `time`).

## What a write changed, and what others changed

Every `film_run` and `film_batch` that is accepted answers `changes`: `{ created, changed, moved,
deleted }`, each object by its id (`9`) and `type`. A change inside a clip is told as a change of
the clip, at a path: an effect's parameter or a keyframe is `effects.<n>.params` (the effect's
place in the clip's `effects`, as `film_inspect` lists them), with parameter values when available. Receipt `before` and `after` members may be omitted;
omission does not mean JSON null. A track whose clip list changed is listed with `fields: ["clips"]` only when nothing else
says so. A ripple edit that shifts 4 or more clips one after another by the same amount is told
once, in `footprint`: `{ parent, field: "clips", from, count, shift: { field: "start", by } }`
(the track, the index of the first shifted clip after the edit, how many, and the shift in ticks,
as a string); `changes: "all"` names every such clip with `start` before and after instead. At
most 50 objects are listed unless you pass `changes: "all"`, and `truncated` counts the rest (a
ripple delete at the start of a 200-clip track: about 250 bytes, about 25 KB with `"all"`).

Every answer carries `revision`. Pass the last one you were given as `basis` on your next write:
what others changed since (another agent, or a person or program that saved the file) comes back
as `others`, in the same form, and the write is refused as `conflict` (nothing runs, nothing is
saved) when what it relies on changed. A clip's `start` and `duration` are where it is in time,
not what it is: a change of them is a move.

The intended refusal rule (C8-time-policy) has two halves: a write is refused exactly when
others changed **what it lands on**, or **a fact its result depends on** as the command's code
reads it; it applies otherwise, and the saved result is both edits. A hold the command's code
does not read is a false refusal, not a policy. What a write lands on is what its address names
as you observed it. An address by time (a point or a range) is a positional address, like an
index: it names what is seen and heard at that time. A change by others after which other
content is at that time (an insert, delete or speed change before it; a move, trim or
replacement of the clip under it) refuses it (`relocated`; `changed` when the clip under it was
edited in place, a slip or a disable), even when the command's code reads no clip there, as an
insert before index 5 refuses a write at index 5. A change after which the same content is at
that time (after it, on a clip elsewhere, of another entry) does not. Where the kit has not yet stated what a command reads, the guard holds
every field and position of what the step names (kition-sdk's default). This can over-refuse;
dependencies outside the named object can also be missing. The implementation remains partial.

Project files with a saved `next_id` below an existing object id are refused before creation
can overwrite an item. Decoding retains counters that precede inline marker/link/group ids;
opening an editing session reserves those identities before any command allocates another id.
Counters and stored ids beyond the exact numeric tool-id range are refused before allocation
can overflow. Replica readers use the same complete id floor and retain the session counter
across undo and refreshes. An edit that exhausts the exact counter fails before its project
or editor state is published, so it cannot create an unreadable saved file.

The independent handler readings are retained separately from reviewed machine comparisons.
Registration coverage does not establish complete dependency coverage. Source-fingerprinted
comparisons exist for reviewed patch paths; other paths still require exact comparisons and
may hold unrelated fields or omit indirect dependencies.

A clean outside reread imports the file difference into the live replica. Selections, Source
state, preferences, user preset definitions and recording inputs remain attached to that
session. An unresolved observed target refuses restoration. An outside edit over unsaved local
work remains a conflict; save or resolve that work before attempting a clean reread.

Later steps of a guarded run are planned on an isolated copy after their preceding steps.
Opening Source earlier in a run therefore supplies the Source item for placement preflight.
A refused plan does not execute its prefix in the live document.

Keep a guarded close last in a run. A completed close returns `closed: true` and
`saved: false`, with no `document`; the closed project is never implicitly saved.
The prefix planner follows a replacement replica, including New Project and Demo
Project, while keeping the live project untouched until preflight succeeds.

Raw object-model writes declare their premise contract. Scalar patches use schema fields and
references; insertions and moves also hold their ordered destinations. Clip lists remain
canonicalized by time, so moving a list member does not retime a clip. Ancestor position holds
can still conservatively refuse structural operations after unrelated track reordering.

Font replacement, metadata-column lookup and mixer routing hold independently addressable
computed facts. A change to another family, column or routing pair does not change the held
fact. Larger mixer graphs retain conservative index holds. Metadata keys containing path
punctuation use literal JSON Pointer segments, including escaping slashes and tildes.

Private computed facts are marked `premiseOnly` and retained for guarding rather
than public changed-object receipts. Public receipt values remain optional.

Track insertion compares name assignments on lanes observed at the checkpoint
and lanes created or assigned by this agent since it. Distant new colleague lanes
do not become positional holds; an observed name changed and then restored still
refuses `changed`. Explicit rename and time-interpolation target spellings do not
hold an unused selection. Their implicit forms compare retained editor checkpoints,
including intermediate outside selection changes. Null content regions reach the
callback unchanged.

Track-targeting commands hold the ordered lane identities used by their result,
or the ordinal lane they address, while ignoring unrelated clip and track content.
Their default targeting also depends on the other lane kinds it carries forward.
Generator durations do not address the Program timeline; only omitted dimensions
and the inherited frame rate hold sequence defaults.

Mask tracking holds the source media and timebase used by its analysis. Other
mask edits hold the selected target's geometry and effects without holding an
unselected clip under the Program playhead. Caption splits hold the sequence
frame duration, and caption timecode addresses hold its drop-frame setting.
Caption navigation holds caption membership, visibility and the frame rate used
to snap its destination. Next and Previous also hold destination clip membership
and linked selection when selection follows the playhead. File-only commands
refuse inside raw batches as well as direct agent calls.

Text-layer creation holds the graphic preferences that supply its defaults.
Nudging a mixed selection holds Motion positions on every selected video clip;
unrelated Opacity edits remain independent. Gap navigation holds the sequence
frame rate used to snap its destination.

Playhead navigation retains its snapping timebase and the sequence duration or edit-point
geometry used by its destination. Select All retains the ordered recipient identities.
Selection-following navigation retains the relative order of explicitly targeted lanes;
default targeting also retains lane membership.
Camera switches retain effective camera identities and enabled flags across inferred and
explicit source maps. Camera display names remain independent. An implicit switch retains
the ordered candidates at its lookup time, including candidates that were ineligible.
Camera page navigation retains the source map used to count shown cameras and clamp pages.
Live camera switches also retain that source map when resolving a recording cut.
Recording cuts and Stop retain the recorded lanes and replayed clip and transition content;
the editor checkpoint retains the live pass identity and cuts. These lane holds include
material outside the pass interval.
Mixer Release and Stop retain held controls and the recorded gestures across file
rereads. Removing a submix retains the bus content and every route it rewrites.
Trim playback also survives rereads. Dynamic replay reverses the previous pass's
changed lists while preserving unrelated project edits, and refuses when those
lists changed outside the pass. Its declarations retain a conservative sequence
and source profile. Nearest-edit selection retains candidate lane and clip geometry.
Marker jumps retain the Program marks or private Source bounds and timebase they consume.
Source marker navigation also retains filtered subclip destinations; adding a Source marker
or changing its duration retains the bounds used to validate and clamp it. Mark Clip and
Mark Selection protect both assigned marks and the geometry used to compute them.

Link, Group, Ungroup and Scale to Frame Size retain the active-sequence scope of
their recipients while allowing moves between lanes of that sequence. An
unlinked Select Clips operation consumes the supplied ids without imposing that
ownership check. Complete dependency comparison remains unfinished; conservative
selection, editor-state and clip-position holds remain in the reviewed paths.

Through joins replay their parameter-selected recipient set using retained predicate values,
including deleted candidates. Large single-target plans retain their conservative fallback.
Live multicamera replay reverses only its previous clip and transition patch before applying
the pass again, retaining unrelated project edits across caller changes and clean rereads.

A write holds fields it assigns as well as values it reads. A ripple insertion explicitly
holds the suffix starts it will assign: a colleague's change to the same start refuses
`changed`, even when the clip remains after the insertion point. Unrelated suffix names are
preserved. This assignment rule also applies when an address in time itself is unchanged.

Reviewed Source placement holds copied source identity, marks, stream geometry, interpretation,
channel destinations, track locks and copied sequence material. Unused source metadata and
track names remain independent in the covered paths. Other source, effect, graphic, caption,
synchronization and editor-input paths still need comparison.

- **Name by id when you can.** A step that names its clips (`on`, or a command's `clip`/`clips`)
  is refused when others deleted one (`deleted`), changed what the step reads of it (`changed`),
  or moved it in a way the step depends on (`relocated`, with `now`: its index in its track and
  its `start` and `duration` now). What a step reads depends on the command: setting an effect
  parameter with no time on a clip with no keyframe reads the clip's effects and nothing of where
  it is, so it applies after a ripple insert moved the clip; on a clip with a keyframe, or given a
  time, it keys the value at the clip's frame under the playhead, so a move refuses it. A keyframe
  edit by `mediaTime` reads the effects alone. `clip.enable` reads the enabled switch and links of
  the clips and of the clips linked to them, `clip.rename` the name. `timeline.slip` reads the
  source In, speed, item, frame hold, link and length of the clip and its linked clips, and the
  resolved source bounds (the media
  it may slip over), not where they are: it applies after a ripple, a move or a move to another
  track, and a trim refuses it. `sequence.setTransition` with only `reverse` writes that switch
  and reads nothing of where the transition is. A write by id whose needs are not stated here is
  held on every field and position of its clip (the default above).
- **When you name by time, pass `basis`.** A step that names no clip and acts at a time
  (`at.time`, or the command's own `time`, `seconds`, `frame`, `timecode`) and on tracks (its
  `track`, the targeted tracks, the source patching) acts on whatever is there when it runs:
  `timeline.selectClipAtPlayhead`, a razor cut on a track, Add Edit, an insert or overwrite
  (`timeline.place`, `source.insert`, `source.overwrite`), a marker, a caption or a title put at
  a time. With `basis`, its premise is the clips that were under that time on those tracks (for
  a marker, a caption or a title, on every track: what is seen and heard there, which its time
  names) and what they show: a clip slipped or changed there refuses it (`changed`). A chapter or
  cue marker given no name also holds the markers, which its default name counts. Whether a clip covers the time is
  replayed from the clips' times, so a change next to the time does not refuse it, and a trim of
  the clip under it that leaves the time covered does not refuse a cut or a `timeline.place`
  insert or overwrite (whose span it still covers). With `snap`, Place Clip
  may land up to the tolerance either side of its time: its place is that whole span, and a
  change of the sequence's markers (`"markers"`) or of an audio clip (`"beats"`) refuses it.
  `timeline.placeMany` and `sound.phrase` are refused after any insert, delete or move by others.
  Without `basis` nothing checks it.
- **`relocated` on a place** means the clips under that time are not the ones you saw: others
  inserted or deleted before it, or moved, trimmed, deleted or placed a clip so that another one
  covers it now. Each conflict names a clip with `now` (where it is) and `place` (the time and
  track as you gave them, and `under`: the clips there now). To retry, decide from `now` where the
  clip you meant has gone (or inspect again) and either name it by id (`on`), or give the new time
  with the `revision` the refusal answered as `basis`. Do not resend the same time: it names
  another clip now.
- **Captions and markers** have no tool id of their own: a change to one is told as a change of
  its sequence's item at a path under `sequence.captions` (a caption's track is under
  `sequence.captionTracks`) or `sequence.markers` (a media
  item's source markers under its `markers`, a clip's under the clip's `markers`). A write to a caption's
  text named by its id is refused (`changed`, naming the item) when others changed that caption's
  text (or speaker) or deleted it, not when they moved it in time; found by its time, the whole
  caption is held, since its time is what names it. Moving, trimming, timing, merging, splitting
  or deleting captions use different holds. Timing, trim, move and add hold timing leaves and
  membership on participating tracks; merge, split and delete still hold broader caption data.
  The owning track's lock is held for text edits. `marker.edit` holds the name, comment or colour it sets (the whole
  marker when it sets a duration, its time); clearing the current marker is refused when it
  changed; clearing all markers when others changed any.
  A caption or a marker is followed by its id across others' saves: one added before it does not
  refuse a write to it, and a change of a clip does not refuse a write to a caption or a marker.
  Caption track settings, style and deletion hold only the track named by its numeric id.
  An ordinal (`"C1"`) or the default also holds that position's identity.
- **Automate to Sequence** given its `items` writes at the playhead: with `method: "overwrite"`
  its place covers only the destination tracks and the individual intervals of its placements,
  including their overlap (or each unnumbered marker, with `placement: "unnumberedMarkers"`).
  A clip others put there since `basis` refuses it; one on another track or between placements
  does not. Insert also holds later clips on destination and sync-locked tracks; inserts at
  markers hold the markers and sync-locked caption tracks that they ripple.
- **Ids as text:** a command's id parameter (`clip`, `item`, `marker`) takes the id as a number or
  as a numeric string (`"9"`), which names the same object.
- **Resolved references:** nested move entries hold their clips, including linked partners that
  move with them, their actual destination intervals, transitions they remove, and captions and
  sync-locked tracks they ripple on insert. Snap edits hold their markers or beat sources.
  Mixer strip, output and send-target references hold the resolved track; the
  mixer accepts case-insensitive names and A1/S1 ordinals. Search-bin edits hold the saved query
  in `Project.searchBins`, separately from ordinary project bins.
- **Authored values and evaluated results:** an unkeyed effect edit holds the clip's stored
  effect stack. A change of the source media or nested sequence does not refuse that edit when
  those stored values are unchanged. A reference placement holds a nested sequence's settings
  and duration; expanding it holds the source content it copies. Multicam flattening holds the
  chosen video angle and the audio tracks selected by the source's audio policy. Ripple speed
  and trim edits hold the placements they shift, track locks and sync locks, and transitions
  attached to affected cuts. These declarations do not cover every content-deriving command.
- **Insertion destinations:** Add Tracks holds the resolved gap in each track list it inserts
  into. A colleague's insertion or deletion before that gap refuses the stale insertion.
  Its additional name and position holds can also refuse a distant appended track.
- **Known diagnostic limit:** folded mixer names lack the SDK's exact-name relocation diagnostic
  when a colleague renames the resolved track away. Caption text follows its caption by its id
  in the sequence's `captions`; removing an earlier track does not refuse an unchanged text.
  An automation interval whose occupant was replaced reports `relocated`, including when the
  reread pairs its old and new occupants structurally.

The saved-file tests in `bindings/headless/tests/time5.rs` declare outcomes before execution,
check that refusals leave bytes unchanged, and verify merged values on covered acceptance paths.
The fixed-seed mixed tables exercise independent writers with their original seed and rules.
`bindings/wasm/tests/declarations_independent.rs` keeps the blind readings and comparison gate.
These checks do not establish complete per-path coverage. Conservative range and structural
holds remain; a fresh observation is required when a comparison cannot be established.

## Previews

`film_inspect` with `preview: true` draws the program picture with the kit's render command,
[`file.render`](/kits/film/commands/file.render/). What it shows is named in `target`, never taken
from the playhead or the open sequence, so the same call shows the same picture every time:

- **One frame:** `target: { "time": 1.5 }` is the frame showing 1.5 s after the sequence's start
  (from 0 to before its end).
- **Motion over a span:** `target: { "range": [2, 6], "frames": 6 }` is one picture of 6 frames
  (2 to 12) spread evenly from 2 s to 6 s, both included, in a grid in reading order; each frame
  has its time burned into its bottom-left corner. A range ending at the sequence's end shows its
  last frame.
- **The whole sequence:** without a `target`, a contact sheet of up to 6 frames from start to end.
- **Which sequence:** `target.sequence` is the sequence's item id. Without it the preview is of the
  project's main sequence: the only sequence no other sequence holds (a nested sequence is part of
  the one it is in). A project with several such sequences has no main one: name it, and the error
  lists the sequences to choose from.
- **A diagnostic's target:** `target: { "path": "sequence:7/clip:11" }` shows the middle of that
  clip; add `time` or `range` to show another moment of sequence 7.
- **Size:** `scale` is picture pixels per sequence pixel (up to 2, default 1; each frame of a
  contact sheet is drawn at it) and `maxSize` the most pixels on the longer side (16 to 4096,
  default 1024); a larger picture is drawn at a smaller scale.

A time outside the sequence, an unknown sequence id or an unnamed sequence where the project has
several is an `invalid_params` error that gives the valid range or lists the sequences.

## Common tasks

### Promo editing: sound on the beat

A promo is cut to music: put the music down, read its beats, cut picture on them, then pin sound
effects to the frames that matter. Each command below is one undo step.

- **Many sounds at once:** [`timeline.placeMany`](/kits/film/commands/timeline.placeMany/)
  `{ "items": [{ "item": 12, "frame": 45, "alignPeak": true, "gainDb": -5.2 }, …] }` puts each
  sound on the first audio track with room for it (never over another sound). `alignPeak` lands the
  sound's loudest moment on `frame` instead of its start: a whoosh or impact has a silent or rising
  head, and placing its start on the cut makes it late. Volume is `gainDb` (or `volume`, linear:
  0.55 → −5.2 dB); `fadeInFrames` / `fadeOutFrames` fade the edges; `durationFrames` cuts a long
  sample short.
- **Stock phrases:** [`sound.phrase`](/kits/film/commands/sound.phrase/) `{ "preset": "closing",
  "frame": 300, "items": { "riser": 21, "impact": 22, "sparkle": 23 } }` builds the closing phrase:
  the riser from the shot start, the impact 35 frames later at 0.55 (the loudest sound of the film;
  use at most three such hits), a sparkle 25 frames after it. `titleIn` (`swoosh`, 0.4), `sceneIn`
  (`transition`, 0.4), `click` (0.6) and `hitRun` (`hit` / `hitAlt` in turn, 0.40 → 0.25 over
  `count` hits, `spacingFrames` tightening to `endSpacingFrames`; give a `swoosh` for hits closer
  than 3 frames, which blur into one sound) are the others. You import the sound files; the command
  only places them.
- **Cut on the beat:** [`audio.detectBeats`](/kits/film/commands/audio.detectBeats/)
  `{ "clip": <music clip>, "markers": true }` answers the beat `frames`; cut your clips there
  ([`timeline.place`](/kits/film/commands/timeline.place/) `… "snap": "beats"`). Then
  [`transition.beatCut`](/kits/film/commands/transition.beatCut/) `{ "effect": ["whip", "flash"],
  "sfx": [<whoosh>, <whoosh 2>] }` centres a transition on every cut that lies on a beat (the
  effects and sounds used in turn) and lands each whoosh's peak on its cut. `effect: "cut"` keeps
  straight cuts and only adds the sounds.
- **Transition parameters:** [`effect.list`](/kits/film/commands/effect.list/)
  `{ "effect": "push" }` answers each parameter's type, range, choices and what it `accepts`.
  Amounts such as `motion_blur` take a number or `true` / `false`; `direction` takes its choice
  ("From East") or where the picture moves (`left`, `right`, `up`, `down`).
- **Karaoke captions:** [`caption.add`](/kits/film/commands/caption.add/) `{ "words": [{ "text":
  "卡点", "start": 1.03, "end": 1.47 }, …] }` (sequence seconds) makes one caption over the words;
  burned in, the word being sung takes the track's
  [`caption.setStyle`](/kits/film/commands/caption.setStyle/) `{ "highlightColor": "#ffd60a",
  "highlightScale": 1.2 }`. Give Chinese per word or per character, as you want it lit; lines break
  between words. For Chinese text call the host's `addFont` with a CJK font and set the track
  `font` first.
- **Music bed:** [`audio.bed`](/kits/film/commands/audio.bed/) `{ "item": <music> }` lays the music
  from frame 0 to the end of the picture at −9.4 dB (≈0.34, room for the effects) with a 1 s fade in
  and a 1.7 s fade out; `duck: { "against": "dialogue", "reduceDb": -12 }` dips it under speech. Do
  the picture first: the bed and every sound are pinned to frames, so a change in shot lengths means
  pinning them again.

## Example 1: a colour matte at the start of an empty sequence

On a new project, `film_check` answers `film.empty-sequence` for `Sequence 01` (`sequence:7`).

```json
film_run { "path": "edit.kfilm", "steps": [{ "command": "item.newColorMatte", "params": { "color": "#1f4e8c", "seconds": 2 } }] }
```

It answers `{ "item": 8 }`. Place that item:

```json
film_run { "path": "edit.kfilm", "steps": [{ "command": "timeline.place", "params": { "item": 8, "track": "V1", "seconds": 0 } }] }
```

It answers `{ "clips": [9] }`, and `film_check` then answers `the kit found nothing wrong`.

## Example 2: close a gap the check reports

```json
film_check { "path": "gap.kfilm" }
```

It answers `{ "code": "film.gap", "message": "Video 1 has 1 s of black between \"Color Matte\" and
\"Color Matte\" at 2 s.", "target": { "path": "sequence:7/clip:11" }, "fix": { "command":
"sequence.closeGap", "params": { "track": "V1", "time": 508540032000 } } }`. Run the fix as given:

```json
film_run { "path": "gap.kfilm", "steps": [{ "command": "sequence.closeGap", "params": { "track": "V1", "time": 508540032000 } }] }
```

`film_check` then answers `the kit found nothing wrong`.

## Example 3: cut at 3.5 s without moving the playhead

```json
film_run { "path": "edit.kfilm", "steps": [{ "command": "timeline.razor", "at": { "time": 3.5 }, "params": { "track": "V1" } }] }
```

It answers `{ "cuts": 1, "clips": [28], … }`: V1 is cut at 3.5 s (frame 84 at 24 fps), and the
playhead is where the person left it. `"params": { "seconds": 3.5, "track": "V1" }` does the same.

## Example 4: edit two sequences in one run

`film_inspect` lists the sequences `Main` (`item` 23, open) and `Other` (`item` 14). Cut V1 of
Main at 3.5 s and V1 of Other at 1 s:

```json
film_run { "path": "edit.kfilm", "steps": [
  { "command": "timeline.razor", "at": { "time": 3.5 }, "params": { "track": "V1" } },
  { "command": "timeline.razor", "at": { "part": { "sequence": 14 }, "time": 1 }, "params": { "track": "V1" } }
] }
```

Each step's `at.time` is in the step's sequence: `at.part`, else the open one. The run puts the
editor back afterwards, so Main is still the open sequence. To see Other's clips, run
[`sequence.inspect`](/kits/film/commands/sequence.inspect/) `{ "item": 14 }`.

## Pitfalls

- **Earlier answers:** `"$0.item"` in a step is not substituted. Read the id from the answer, then
  use it in the next call.
- **A failed step** stops the run and the kit undoes the steps before it, so the project is as it
  was before the call and nothing is saved (an item made in step 0 is gone). Read `error.index`
  for the failing step, fix it, and send the whole run again.
- **Ticks or seconds:** a `time`, `duration` or `sourceIn` in a command is in ticks, not seconds.
  Use `seconds` where the schema offers it, or the step's `at.time`. A preview's `target.time`
  and `target.range` are seconds.
- **The open sequence after a run:** the run puts it back; name another sequence in each step's
  `at.part` (or the run's `target`).
- **Shot lengths:** sounds and the music bed are pinned to frames, so finish the picture before you
  place them.

## Checks

`film_check` lists what is wrong with the project. Each diagnostic has a stable `code`, a
`severity` (`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a
command step to run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it
only when it is what the person asked for. Every code the kit reports is on the
[checks page](/kits/film/checks/).

- `film.offline-media` (error): the clip renders the offline slate; relinking needs the person's
  file.
- `film.missing-media` (error): the clip's media names a file the host does not lend (missing, or
  outside the workspace), so it renders the offline slate. The kit reads media only from the
  workspace: ask the person to put the file there, then link it with `media.relink`.
- `film.missing-item` (error): a clip whose project item is gone. Replace or delete the clip.
- `film.past-media-end` (warning): a clip reads beyond its footage, so its last frames freeze.
  Shorten it or move its source in. Stills and generators have no end.
- `film.empty-sequence` (warning): nothing to render yet.
- `film.gap` (info): V1 shows black between two clips. Its `fix` is
  [`sequence.closeGap`](/kits/film/commands/sequence.closeGap/) with the track and time; close gaps
  only when the person wants a continuous cut.
- `film.disabled-clip` (info): the clip neither shows nor plays. Its `fix` is
  [`clip.enable`](/kits/film/commands/clip.enable/).
