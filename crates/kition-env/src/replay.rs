use std::collections::BTreeMap;

use serde_json::Value;

pub(crate) type Bindings = BTreeMap<String, String>;

#[derive(Default)]
pub(crate) struct ReplayIds(pub Bindings);

impl ReplayIds {
    pub fn learn(&mut self, bindings: &Bindings, answer: &Value) {
        for (recorded, reference) in bindings {
            if let Some(actual) = answer["refs"][reference].as_str() {
                self.0.insert(recorded.clone(), actual.to_owned());
            }
        }
    }

    pub fn json(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.0.get(text).cloned().unwrap_or_else(|| text.clone())),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.json(item)).collect()),
            Value::Object(members) => {
                Value::Object(members.iter().map(|(key, value)| (self.0.get(key).cloned().unwrap_or_else(|| key.clone()), self.json(value))).collect())
            }
            other => other.clone(),
        }
    }

    pub fn arguments(&self, arguments: &Value) -> Value {
        let mut arguments = self.json(arguments);
        for op in arguments["ops"].as_array_mut().into_iter().flatten() {
            for field in ["target", "in"] {
                if let Some(text) = op[field].as_str() {
                    let replaced = self
                        .0
                        .iter()
                        .filter_map(|(old, new)| text.strip_prefix(&format!("{old}.")).map(|path| (old.len(), format!("{new}.{path}"))))
                        .max_by_key(|(length, _)| *length);
                    if let Some((_, text)) = replaced {
                        op[field] = Value::String(text);
                    }
                }
            }
        }
        arguments
    }

    pub fn batch_arguments(&self, arguments: &Value, bindings: &Bindings) -> Value {
        let original = arguments;
        let mut arguments = self.arguments(original);
        let mut local = Self(self.0.clone());
        for (op, original) in arguments["ops"].as_array_mut().into_iter().flatten().zip(original["ops"].as_array().into_iter().flatten()) {
            *op = local.arguments(&serde_json::json!({"ops":[original]}))["ops"][0].clone();
            if op["op"] == "create"
                && let Some(reference) = op["ref"].as_str()
            {
                for (recorded, binding) in bindings {
                    if binding == reference {
                        local.0.insert(recorded.clone(), reference.to_owned());
                    }
                }
            }
        }
        if let Some(load) = arguments.get_mut("load") {
            *load = local.json(&original["load"]);
        }
        arguments
    }
}
