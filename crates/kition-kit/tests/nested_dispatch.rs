// `kition_kit::testing::check_nested_dispatch_is_gated`: a kit's own batch, macro and script
// commands run their steps through the host's gate (regressions/issue-agent-command-gate).

use kition_kit::testing::{Dispatcher, check_nested_dispatch_is_gated, step_list};
use kition_kit::{KitCommand, KitDocument};
use serde_json::{Value, json};

/// A toy kit with dispatchers: `macro.run` asks the gate before each step; `script.run` asks it
/// only when `GATED`; `rows.custom` takes its steps under a name the check cannot guess;
/// `text.batchReplace` runs no commands at all.
struct Toy<const GATED: bool> {
    revision: u64,
}

impl<const GATED: bool> Toy<GATED> {
    fn step(&mut self, command: &str, params: Value, ask: bool) -> Result<Value, String> {
        if ask {
            kition_kit::dispatch::may_run(command, &params)?;
        }
        self.execute(command, params)
    }
}

impl<const GATED: bool> KitDocument for Toy<GATED> {
    fn open(_name: &str, _bytes: &[u8]) -> Result<Self, String> {
        Ok(Self { revision: 0 })
    }
    fn create(_name: &str, _width: u32, _height: u32) -> Result<Self, String> {
        Ok(Self { revision: 0 })
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
        false
    }
    fn render(&self, _x: f64, _y: f64, _scale: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
        Ok(vec![0; (width * height * 4) as usize])
    }
    fn render_area(&self, _x0: i32, _y0: i32, _x1: i32, _y1: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        Ok(vec![0; (width * height * 4) as usize])
    }
    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
        match command {
            "view.info" => Ok(json!({ "revision": self.revision })),
            "shape.add" => {
                self.revision += 1;
                Ok(Value::Null)
            }
            "macro.run" => {
                for step in params["steps"].as_array().cloned().unwrap_or_default() {
                    self.step(step["command"].as_str().unwrap_or_default(), step["params"].clone(), true)?;
                }
                Ok(Value::Null)
            }
            "rows.custom" => {
                for step in params["rows"]["then"].as_array().cloned().unwrap_or_default() {
                    self.step(step.as_str().unwrap_or_default(), json!({}), true)?;
                }
                Ok(Value::Null)
            }
            "script.run" => {
                for line in params["text"].as_str().unwrap_or_default().lines() {
                    let (id, rest) = line.split_once(' ').unwrap_or((line, "{}"));
                    self.step(id, serde_json::from_str(rest).map_err(|error| error.to_string())?, GATED)?;
                }
                Ok(Value::Null)
            }
            "text.batchReplace" => Ok(json!({ "replaced": 0 })),
            other => Err(format!("unknown command `{other}`")),
        }
    }
    fn inspect(&self) -> Result<Value, String> {
        Ok(json!({ "canUndo": false, "canRedo": false }))
    }
    fn commands(&self) -> Vec<KitCommand> {
        let command = |id: &str, schema: Value, mutates: bool| KitCommand {
            id: id.into(),
            title: id.into(),
            schema: Some(schema),
            mutates,
            enabled: true,
            ..Default::default()
        };
        vec![
            command("shape.add", json!({}), true),
            command("view.info", json!({}), false),
            command(
                "macro.run",
                json!({ "steps": { "type": "array", "required": true, "items": { "type": "object", "additionalProperties": false, "properties": {
                    "command": { "type": "string", "required": true }, "params": { "type": "json" },
                } } } }),
                true,
            ),
            command("rows.custom", json!({ "rows": { "type": "json", "required": true } }), true),
            command("script.run", json!({ "text": { "type": "string", "required": true } }), true),
            command("text.batchReplace", json!({ "text": { "type": "string" } }), true),
        ]
    }
    fn save(&self, _name: Option<&str>) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
    fn mark_saved(&mut self) {}
}

const CUSTOM: Dispatcher<'static> = Dispatcher { command: "rows.custom", wrap: |command, _| json!({ "rows": { "then": [command] } }) };
const NOT: [(&str, &str); 1] = [("text.batchReplace", "replaces text; it runs no commands")];

#[test]
fn a_dispatcher_that_runs_a_step_without_asking_the_gate_fails_the_check() {
    let problems = check_nested_dispatch_is_gated(|| Toy::<false>::create("a", 1, 1).unwrap(), &[CUSTOM], &NOT).unwrap_err();
    assert_eq!(problems.len(), 1, "{problems:#?}");
    assert!(problems[0].starts_with("script.run: ran its step `view.info` without asking kition_kit::dispatch::may_run"), "{problems:#?}");

    // Unlisted, the dispatcher the heuristic misses is not checked, and the one that runs no
    // commands is a problem until the kit says why.
    let problems = check_nested_dispatch_is_gated(|| Toy::<true>::create("a", 1, 1).unwrap(), &[], &[]).unwrap_err();
    assert!(problems.iter().any(|problem| problem.starts_with("text.batchReplace: ran its step")), "{problems:#?}");
    assert!(!problems.iter().any(|problem| problem.starts_with("rows.custom")), "{problems:#?}");
}

#[test]
fn dispatchers_that_ask_the_gate_pass_and_the_lists_cannot_go_stale() {
    let checked = check_nested_dispatch_is_gated(|| Toy::<true>::create("a", 1, 1).unwrap(), &[CUSTOM], &NOT).unwrap();
    assert_eq!(checked, ["rows.custom", "macro.run", "script.run"]);
    let stale = Dispatcher { command: "no.such", wrap: step_list };
    let problems = check_nested_dispatch_is_gated(|| Toy::<true>::create("a", 1, 1).unwrap(), &[stale], &[("shape.add", "draws")]).unwrap_err();
    assert!(problems.contains(&"dispatchers names no.such, which is not a command".to_owned()), "{problems:#?}");
    assert!(problems.contains(&"not_dispatchers names shape.add, which the check does not take for a dispatcher".to_owned()), "{problems:#?}");
}
