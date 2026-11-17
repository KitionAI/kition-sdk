//! Read-only kit callbacks shared by the editor export and native hosts.
use serde_json::{Value, json};

use crate::{ContentAsk, CoveredAsk, HistoricalBlobs, KitDocument};

struct History<'a>(&'a Value);

impl HistoricalBlobs for History<'_> {
    fn read(&self, hash: &str, offset: usize, length: usize) -> Result<Vec<u8>, String> {
        let bytes: Vec<u8> = serde_json::from_value(self.0[hash].clone()).map_err(|_| "historical blob bytes unavailable in this editor".to_owned())?;
        if length > 1024 * 1024 || offset > bytes.len() {
            return Err("historical blob range is unavailable".into());
        }
        Ok(bytes[offset..offset.saturating_add(length).min(bytes.len())].to_vec())
    }
}

/// Answers a premise request in the state selected by the editor worker. `null` from `under`
/// means the kit declares no additional premises; errors are unavailable, never permission.
pub fn read<D: KitDocument>(document: &D, method: &str, params: &Value) -> Result<Value, String> {
    let mut step: crate::PremiseStep = serde_json::from_value(params.clone()).map_err(|error| error.to_string())?;
    step.state = document.editor_state();
    let encode = |value| serde_json::to_value(value).map_err(|error| error.to_string());
    let history = History(&params["history"]);
    match method {
        #[cfg(feature = "session")]
        "projected" => serde_json::to_value(document.projected_objects()?).map_err(|error| error.to_string()),
        "state" => Ok(json!({"state":document.editor_state()})),
        "under" => encode(document.under_step(params["command"].as_str().ok_or("command required")?, &params["params"], &step)?),
        "covered" => {
            let objects: Vec<CoveredAsk> = serde_json::from_value(params["objects"].clone()).map_err(|error| error.to_string())?;
            serde_json::to_value(document.covered_step(params["command"].as_str().ok_or("command required")?, &params["params"], &objects, &history, &step)?)
                .map_err(|error| error.to_string())
        }
        "content" => {
            let mut ask: ContentAsk = serde_json::from_value(params.clone()).map_err(|error| error.to_string())?;
            ask.step = step;
            Ok(json!({"changed":document.content_at(&ask, &history)?}))
        }
        #[cfg(feature = "session")]
        "blob-support" => Ok(json!({"available":document.blob_source().is_some()})),
        #[cfg(feature = "session")]
        "blob" => {
            let hash = params["hash"].as_str().ok_or("hash required")?;
            let bytes = document.blob_source().and_then(|source| source.get(hash)).ok_or("blob unavailable")?;
            let offset = params["offset"].as_u64().and_then(|value| usize::try_from(value).ok()).ok_or("invalid offset")?;
            let length =
                params["length"].as_u64().and_then(|value| usize::try_from(value).ok()).filter(|value| *value <= 1024 * 1024).ok_or("invalid length")?;
            if offset > bytes.len() {
                return Err("invalid offset".into());
            }
            Ok(json!({"available":true,"size":bytes.len(),"data":bytes[offset..offset.saturating_add(length).min(bytes.len())]}))
        }
        "identity" => Ok(json!({"unproven":document.unproven_identities(params["objects"].as_array().ok_or("objects required")?)?})),
        "inputs" => Ok(json!({"inputs":document.external_inputs()?})),
        "carried" => {
            Ok(json!({"objects":document.carried(params["ids"].as_array().ok_or("ids required")?, params["changes"].as_array().ok_or("changes required")?)?}))
        }
        "derived" => {
            let ids = params["ids"].as_array().cloned().unwrap_or_default();
            let names: Vec<String> = serde_json::from_value(params.get("names").cloned().unwrap_or(json!([]))).map_err(|error| error.to_string())?;
            Ok(json!({"objects":document.derived(&ids, &names)?}))
        }
        _ => Err(format!("unsupported premise request: {method}")),
    }
}
