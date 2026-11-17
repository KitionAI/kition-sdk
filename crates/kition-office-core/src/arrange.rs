//! `drawing.arrange`: where objects sit in the stack of the slide, page, or sheet they are on.
//!
//! A kit lists its objects bottom to top, [`arrange`] answers the new order, and the kit stores
//! it its own way (a slide's shape list, a page's `relativeHeight`s, a sheet drawing's anchors).

use serde_json::Value;

use crate::ops::{DrawingError, Result};

/// How `drawing.arrange` moves its objects, as Office's Arrange commands do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order {
    /// Bring to Front: above every other object.
    Front,
    /// Send to Back: below every other object.
    Back,
    /// Bring Forward: above the next object over them.
    Forward,
    /// Send Backward: below the next object under them.
    Backward,
}

impl Order {
    pub fn name(self) -> &'static str {
        match self {
            Order::Front => "front",
            Order::Back => "back",
            Order::Forward => "forward",
            Order::Backward => "backward",
        }
    }

    /// `drawing.arrange`'s parameters: `{ids, order}`.
    pub fn parse(p: &Value) -> Result<(Vec<String>, Order)> {
        let ids: Vec<String> = match p.get("ids") {
            Some(Value::Array(a)) => a.iter().map(|v| v.as_str().map(str::to_string).or_else(|| v.as_u64().map(|n| n.to_string()))).collect::<Option<_>>(),
            _ => None,
        }
        .filter(|ids: &Vec<String>| !ids.is_empty())
        .ok_or_else(|| DrawingError::invalid("`ids` lists the objects to move"))?;
        let order = match p.get("order").and_then(Value::as_str) {
            Some("front") => Order::Front,
            Some("back") => Order::Back,
            Some("forward") => Order::Forward,
            Some("backward") => Order::Backward,
            _ => return Err(DrawingError::invalid("`order` is front, back, forward or backward")),
        };
        Ok((ids, order))
    }
}

/// `drawing.group`'s `ids` (two or more objects, each once) or `drawing.ungroup`'s (one or
/// more groups), as strings.
pub fn group_ids(p: &Value, at_least: usize) -> Result<Vec<String>> {
    let ids: Vec<String> = match p.get("ids") {
        Some(Value::Array(a)) => a.iter().map(|v| v.as_str().map(str::to_string).or_else(|| v.as_u64().map(|n| n.to_string()))).collect::<Option<_>>(),
        _ => None,
    }
    .ok_or_else(|| DrawingError::invalid("`ids` lists the objects"))?;
    if ids.len() < at_least {
        return Err(DrawingError::invalid(if at_least > 1 { "a group holds two or more objects" } else { "`ids` names the groups" }));
    }
    if ids.iter().enumerate().any(|(i, id)| ids[..i].contains(id)) {
        return Err(DrawingError::invalid("an object is named twice"));
    }
    Ok(ids)
}

/// The new bottom-to-top order of `stack` with `ids` moved by `order`. The moved objects keep
/// their order among themselves. An id not in `stack` is `not-found`.
pub fn arrange(stack: &[String], ids: &[String], order: Order) -> Result<Vec<String>> {
    if let Some(missing) = ids.iter().find(|id| !stack.contains(id)) {
        return Err(DrawingError::not_found(missing));
    }
    let moved = |id: &String| ids.contains(id);
    let mut out: Vec<String> = stack.to_vec();
    match order {
        Order::Front | Order::Back => {
            let (mine, rest): (Vec<String>, Vec<String>) = stack.iter().cloned().partition(moved);
            out = if order == Order::Front { [rest, mine].concat() } else { [mine, rest].concat() };
        }
        Order::Forward => {
            // From the top down: each moved object takes the place of the unmoved one above it.
            for i in (0..out.len().saturating_sub(1)).rev() {
                if moved(&out[i]) && !moved(&out[i + 1]) {
                    out.swap(i, i + 1);
                }
            }
        }
        Order::Backward => {
            for i in 1..out.len() {
                if moved(&out[i]) && !moved(&out[i - 1]) {
                    out.swap(i, i - 1);
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn objects_move_in_the_stack_as_office_moves_them() {
        let stack = s(&["a", "b", "c", "d"]);
        assert_eq!(arrange(&stack, &s(&["b"]), Order::Front).unwrap(), s(&["a", "c", "d", "b"]));
        assert_eq!(arrange(&stack, &s(&["c"]), Order::Back).unwrap(), s(&["c", "a", "b", "d"]));
        assert_eq!(arrange(&stack, &s(&["b"]), Order::Forward).unwrap(), s(&["a", "c", "b", "d"]));
        assert_eq!(arrange(&stack, &s(&["c"]), Order::Backward).unwrap(), s(&["a", "c", "b", "d"]));
        // Several keep their order among themselves.
        assert_eq!(arrange(&stack, &s(&["a", "c"]), Order::Front).unwrap(), s(&["b", "d", "a", "c"]));
        assert_eq!(arrange(&stack, &s(&["a", "b"]), Order::Forward).unwrap(), s(&["c", "a", "b", "d"]));
        assert_eq!(arrange(&stack, &s(&["c", "d"]), Order::Backward).unwrap(), s(&["a", "c", "d", "b"]));
        // At the top already: nothing moves.
        assert_eq!(arrange(&stack, &s(&["d"]), Order::Forward).unwrap(), stack);
        assert_eq!(arrange(&stack, &s(&["a"]), Order::Backward).unwrap(), stack);
        assert!(arrange(&stack, &s(&["z"]), Order::Front).is_err());
    }

    #[test]
    fn a_group_takes_two_or_more_distinct_objects() {
        assert_eq!(group_ids(&json!({ "ids": ["1", 2] }), 2).unwrap(), s(&["1", "2"]));
        assert!(group_ids(&json!({ "ids": ["1"] }), 2).is_err());
        assert!(group_ids(&json!({ "ids": ["1", "1"] }), 2).is_err());
        assert_eq!(group_ids(&json!({ "ids": ["g"] }), 1).unwrap(), s(&["g"]));
        assert!(group_ids(&json!({}), 1).is_err());
    }

    #[test]
    fn parameters_name_the_objects_and_the_order() {
        assert_eq!(Order::parse(&json!({ "ids": ["1", 2], "order": "back" })).unwrap(), (s(&["1", "2"]), Order::Back));
        assert!(Order::parse(&json!({ "ids": [], "order": "back" })).is_err());
        assert!(Order::parse(&json!({ "ids": ["1"], "order": "up" })).is_err());
    }
}
