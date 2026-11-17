//! Grid Kit: the smallest complete kit on the Kition SDK, to copy when starting a kit.
//!
//! A grid document is a header `GRID <width> <height>` and a newline, then one grey byte per
//! pixel. It opens, renders (exact box means for reductions), runs `grid.set`, undoes, saves,
//! reads a granted file by its handle (`grid.import`, engine contract E15), produces a file for the host to
//! write (`grid.exportPgm`, E16), and exports itself to JavaScript, and it does not depend on
//! wasm-bindgen: the SDK's macro brings it. `cargo build -p grid-kit --target wasm32-unknown-unknown` checks exactly that.
#![forbid(unsafe_code)]
#![allow(clippy::cast_possible_truncation)]

use kition_kit::outputs::Outputs;
use kition_kit::tools::{KitTools, PointerAction, ToolInfo, ToolMods, ToolOverlay, ToolPointer, ToolResponse};
use kition_kit::{KitCommand, KitDocument, host};
use serde_json::{Value, json};

#[derive(Clone)]
pub struct GridDocument {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    history: Vec<Vec<u8>>,
    revision: u64,
    saved_revision: u64,
    /// Files `grid.exportPgm` made that the host has not taken yet.
    outputs: Outputs,
    /// False in the broken variant: `render_area` samples one pixel instead of averaging.
    pub box_mean: bool,
}

impl GridDocument {
    fn grey(&self, x: i64, y: i64) -> u8 {
        if x < 0 || y < 0 || x >= i64::from(self.width) || y >= i64::from(self.height) {
            return 0;
        }
        self.pixels[(y as usize) * self.width as usize + x as usize]
    }
}

fn rgba(grey: u8) -> [u8; 4] {
    [grey, grey, grey, 255]
}

impl KitDocument for GridDocument {
    fn open(_name: &str, bytes: &[u8]) -> Result<Self, String> {
        let text_end = bytes.iter().position(|b| *b == b'\n').ok_or("not a grid")?;
        let header = std::str::from_utf8(&bytes[..text_end]).map_err(|_| "not a grid")?;
        let mut parts = header.split(' ');
        if parts.next() != Some("GRID") {
            return Err("not a grid".into());
        }
        let width: u32 = parts.next().and_then(|v| v.parse().ok()).ok_or("bad width")?;
        let height: u32 = parts.next().and_then(|v| v.parse().ok()).ok_or("bad height")?;
        let pixels = bytes[text_end + 1..].to_vec();
        if pixels.len() != (width * height) as usize {
            return Err("truncated grid".into());
        }
        Ok(Self { width, height, pixels, history: Vec::new(), revision: 0, saved_revision: 0, outputs: Outputs::default(), box_mean: true })
    }

    fn create(name: &str, width: u32, height: u32) -> Result<Self, String> {
        let mut bytes = format!("GRID {width} {height}\n").into_bytes();
        bytes.extend(std::iter::repeat_n(255u8, (width * height) as usize));
        Self::open(name, &bytes)
    }

    fn width(&self) -> u32 {
        self.width
    }

    fn height(&self) -> u32 {
        self.height
    }

    fn revision(&self) -> u64 {
        self.revision
    }

    fn dirty(&self) -> bool {
        self.revision != self.saved_revision
    }

    fn render(&self, x: f64, y: f64, scale: f64, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for row in 0..height {
            for col in 0..width {
                let gx = (x + f64::from(col) / scale).floor() as i64;
                let gy = (y + f64::from(row) / scale).floor() as i64;
                out.extend(rgba(self.grey(gx, gy)));
            }
        }
        Ok(out)
    }

    fn render_area(&self, x0: i32, y0: i32, x1: i32, y1: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let (kx, ky) = ((x1 - x0) as u32 / width.max(1), (y1 - y0) as u32 / height.max(1));
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for row in 0..height {
            for col in 0..width {
                let (bx, by) = (i64::from(x0) + i64::from(col * kx), i64::from(y0) + i64::from(row * ky));
                let grey = if self.box_mean {
                    let mut sum = 0u32;
                    for dy in 0..ky {
                        for dx in 0..kx {
                            sum += u32::from(self.grey(bx + i64::from(dx), by + i64::from(dy)));
                        }
                    }
                    ((sum + kx * ky / 2) / (kx * ky).max(1)) as u8
                } else {
                    self.grey(bx, by)
                };
                out.extend(rgba(grey));
            }
        }
        Ok(out)
    }

    fn execute(&mut self, command: &str, params: Value) -> Result<Value, String> {
        match command {
            "grid.set" => {
                let x = params["x"].as_u64().ok_or("x")? as usize;
                let y = params["y"].as_u64().ok_or("y")? as usize;
                let grey = params["grey"].as_u64().ok_or("grey")? as u8;
                let at = y * self.width as usize + x;
                if at >= self.pixels.len() {
                    return Err("outside the grid".into());
                }
                self.history.push(self.pixels.clone());
                self.pixels[at] = grey;
                self.revision += 1;
                Ok(json!({ "changed": true }))
            }
            "edit.undo" => {
                let previous = self.history.pop().ok_or("nothing to undo")?;
                self.pixels = previous;
                self.revision += 1;
                Ok(json!({ "changed": true }))
            }
            "edit.redo" => Err("nothing to redo".into()),
            // Replaces the pixels with a granted file of grey bytes, one per pixel. The file comes
            // as a handle the engine reads through the host; it never sees a path.
            "grid.import" => {
                let file = params["file"].as_str().ok_or("file")?;
                if !host::is_handle(file) {
                    return Err("file is a granted file's handle".into());
                }
                let bytes = host::read(file)?;
                if bytes.len() != self.pixels.len() {
                    return Err(format!("the file has {} bytes; the grid has {} pixels", bytes.len(), self.pixels.len()));
                }
                self.history.push(std::mem::replace(&mut self.pixels, bytes));
                self.revision += 1;
                Ok(json!({ "changed": true }))
            }
            // The grid as a binary PGM image, for the host to write: the engine does no IO.
            "grid.exportPgm" => {
                let mut pgm = format!("P5\n{} {}\n255\n", self.width, self.height).into_bytes();
                pgm.extend(&self.pixels);
                Ok(kition_kit::outputs::answer(&[self.outputs.keep(pgm, "Grid.pgm", "image/x-portable-graymap")]))
            }
            other => Err(format!("unknown command {other}")),
        }
    }

    fn inspect(&self) -> Result<Value, String> {
        Ok(json!({ "width": self.width, "height": self.height, "canUndo": !self.history.is_empty(), "canRedo": false }))
    }

    fn commands(&self) -> Vec<KitCommand> {
        let command = |id: &str, title: &str, description: &str, shortcut: Option<&str>, enabled: bool| KitCommand {
            id: id.into(),
            title: title.into(),
            description: description.into(),
            menu: Some(vec!["Edit".into()]),
            shortcut: shortcut.map(Into::into),
            params: None,
            mutates: true,
            enabled,
            ..Default::default()
        };
        vec![
            command("edit.undo", "Undo", "Takes back the last pixel change, one step at a time.", Some("Cmd+Z"), !self.history.is_empty()),
            command(
                "edit.redo",
                "Redo",
                "Puts back the change Undo last took back; the grid keeps no redo steps, so it is always off.",
                Some("Cmd+Shift+Z"),
                false,
            ),
            KitCommand {
                params: Some(r#"{"x":u32,"y":u32,"grey":0..255}"#.into()),
                ..command("grid.set", "Set Pixel", "Sets one pixel's grey level (0 black, 255 white) at a column and row counted from 0.", None, true)
            }
            .with_kit_schema(),
            KitCommand {
                schema: Some(
                    json!({ "file": { "type": "file", "access": "read", "accept": ["grey"], "required": true, "description": "Grey bytes, one per pixel" } }),
                ),
                ..command(
                    "grid.import",
                    "Import Grey Bytes",
                    "Replaces every pixel with the bytes of a granted file, one grey level per pixel in row order.",
                    None,
                    true,
                )
            },
            KitCommand {
                schema: Some(json!({})),
                output_schema: Some(kition_kit::outputs::output_schema()),
                mutates: false,
                ..command(
                    "grid.exportPgm",
                    "Export PGM",
                    "Writes the grid as a new PGM picture without changing it, and answers the output to take.",
                    None,
                    true,
                )
            },
        ]
    }

    fn save(&self, _name: Option<&str>) -> Result<Vec<u8>, String> {
        let mut bytes = format!("GRID {} {}\n", self.width, self.height).into_bytes();
        bytes.extend(&self.pixels);
        Ok(bytes)
    }

    fn mark_saved(&mut self) {
        self.saved_revision = self.revision;
    }

    fn take_output(&mut self, id: &str, max: Option<usize>) -> Result<Vec<u8>, String> {
        self.outputs.take(id, max)
    }
}

kition_kit::export_kit_document!(GridDocument as "GridDocument");

impl GridDocument {
    /// The grey level at a pixel, or 0 outside the grid: an extra beyond the contract.
    pub fn grey_at(&self, x: u32, y: u32) -> u32 {
        if x >= self.width || y >= self.height {
            return 0;
        }
        u32::from(self.pixels[(y * self.width + x) as usize])
    }
}

/// The kit's own extras on the exported class, through the SDK's wasm-bindgen.
#[cfg(target_arch = "wasm32")]
mod web {
    use kition_kit::wasm_bindgen::prelude::*;

    use crate::__kition_kit_export::WebDocument;

    #[wasm_bindgen(js_class = "GridDocument", wasm_bindgen = kition_kit::wasm_bindgen)]
    impl WebDocument {
        #[wasm_bindgen(js_name = greyAt)]
        pub fn grey_at(&self, x: u32, y: u32) -> u32 {
            self.0.grey_at(x, y)
        }
    }
}

/// One engine tool, a pencil that blackens the pixel under the pointer: the smallest use of the
/// engine-tools capability (the host's generic tool bridge drives it).
impl KitTools for GridDocument {
    fn tools(&self) -> Vec<ToolInfo> {
        vec![ToolInfo { id: "pencil".into(), label: "Pencil".into(), shortcut: Some("N".into()), icon: "pencil".into(), group: 0 }]
    }

    fn tool(&self) -> String {
        "pencil".into()
    }

    fn select_tool(&mut self, id: &str, _zoom: f64) -> Result<ToolResponse, String> {
        if id == "pencil" { Ok(ToolResponse { cursor: "crosshair".into(), ..Default::default() }) } else { Err(format!("no tool {id}")) }
    }

    fn pointer(&mut self, event: &ToolPointer) -> Result<ToolResponse, String> {
        if matches!(event.action, PointerAction::Down | PointerAction::Drag) && event.x >= 0.0 && event.y >= 0.0 {
            let (x, y) = (event.x as u32, event.y as u32);
            if x < self.width && y < self.height {
                self.execute("grid.set", json!({ "x": x, "y": y, "grey": 0 }))?;
            }
        }
        Ok(self.state(event.x, event.y, event.mods, event.zoom))
    }

    fn key(&mut self, _key: &str, _mods: ToolMods, _zoom: f64) -> Result<ToolResponse, String> {
        Ok(ToolResponse::default())
    }

    fn text(&mut self, _text: &str, _zoom: f64) -> Result<ToolResponse, String> {
        Ok(ToolResponse::default())
    }

    fn state(&mut self, x: f64, y: f64, _mods: ToolMods, _zoom: f64) -> ToolResponse {
        let (px, py) = (x.floor(), y.floor());
        ToolResponse { overlays: vec![ToolOverlay::Marquee { x0: px, y0: py, x1: px + 1.0, y1: py + 1.0 }], cursor: "crosshair".into(), ..Default::default() }
    }
}

kition_kit::export_kit_tools!(GridDocument as "GridDocument");
