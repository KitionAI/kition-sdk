//! The workbook embedded with a chart (`c:externalData`), so the chart's data stay editable as
//! cells in the application that opens the file ("Edit Data").
//!
//! [`workbook`] makes a small SpreadsheetML package holding a chart's data: categories down
//! column A from row 2, one series per column from B with its name in row 1. [`Layout`] names
//! the ranges, which [`super::codec::bind_workbook`] writes into the chart part's series.

use std::io::{Cursor, Write};

use super::{ChartKind, ChartSpec};

/// The sheet the data are on.
pub const SHEET: &str = "Sheet1";

/// The ranges a chart's data take in its workbook.
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    /// `Sheet1!$A$2:$A$4`.
    pub categories: String,
    /// Per series: its name's cell and its values' range.
    pub series: Vec<(String, String)>,
}

/// A column's letters (0: `A`).
fn column(mut i: usize) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b'A' + (i % 26) as u8);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    out.reverse();
    String::from_utf8_lossy(&out).into_owned()
}

/// Where `spec`'s data go.
pub fn layout(spec: &ChartSpec) -> Layout {
    let n = spec.categories.len().max(1);
    let last = n + 1;
    Layout {
        categories: format!("{SHEET}!$A$2:$A${last}"),
        series: (0..spec.series.len())
            .map(|i| {
                let c = column(i + 1);
                (format!("{SHEET}!${c}$1"), format!("{SHEET}!${c}$2:${c}${last}"))
            })
            .collect(),
    }
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // Characters XML 1.0 does not allow are left out.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

fn text_cell(r: &str, s: &str) -> String {
    format!(r#"<c r="{r}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#, esc(s))
}

/// The worksheet holding `spec`'s data.
fn sheet_xml(spec: &ChartSpec) -> String {
    let scatter = spec.kind == ChartKind::Scatter;
    let mut rows = String::new();
    // Row 1: the series' names.
    rows.push_str(r#"<row r="1">"#);
    for (i, s) in spec.series.iter().enumerate() {
        rows.push_str(&text_cell(&format!("{}1", column(i + 1)), &s.name));
    }
    rows.push_str("</row>");
    for (k, cat) in spec.categories.iter().enumerate() {
        let r = k + 2;
        rows.push_str(&format!(r#"<row r="{r}">"#));
        // A scatter chart's X values are numbers when they read as numbers.
        match cat.trim().parse::<f64>().ok().filter(|v| scatter && v.is_finite()) {
            Some(v) => rows.push_str(&format!(r#"<c r="A{r}"><v>{v}</v></c>"#)),
            None => rows.push_str(&text_cell(&format!("A{r}"), cat)),
        }
        for (i, s) in spec.series.iter().enumerate() {
            if let Some(v) = s.values.get(k).copied().flatten().filter(|v| v.is_finite()) {
                rows.push_str(&format!(r#"<c r="{}{r}"><v>{v}</v></c>"#, column(i + 1)));
            }
        }
        rows.push_str("</row>");
    }
    let last = format!("{}{}", column(spec.series.len()), spec.categories.len() + 1);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:{last}"/><sheetData>{rows}</sheetData></worksheet>"#
    )
}

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#;

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;

const WORKBOOK: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#;

const WORKBOOK_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;

const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#;

/// The relationship type that names an embedded workbook from a chart part.
pub const PACKAGE_REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package";
/// The content type of an embedded workbook part.
pub const XLSX_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/// A workbook (`.xlsx` bytes) holding `spec`'s data as [`layout`] places them.
pub fn workbook(spec: &ChartSpec) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let sheet = sheet_xml(spec);
    let parts: [(&str, &str); 6] = [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", ROOT_RELS),
        ("xl/workbook.xml", WORKBOOK),
        ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS),
        ("xl/styles.xml", STYLES),
        ("xl/worksheets/sheet1.xml", sheet.as_str()),
    ];
    for (name, body) in parts {
        // Writing to memory does not fail; a failure leaves the package without the part.
        if zip.start_file(name, options).is_ok() {
            let _ = zip.write_all(body.as_bytes());
        }
    }
    zip.finish().map(Cursor::into_inner).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn a_charts_data_go_into_a_workbook_where_its_layout_says() {
        let mut spec = ChartSpec::sample(ChartKind::Column);
        spec.categories[1] = "Q2 & <more>".into();
        spec.series[1].values[2] = None;
        let l = layout(&spec);
        assert_eq!(l.categories, "Sheet1!$A$2:$A$4");
        assert_eq!(l.series[1], ("Sheet1!$C$1".to_string(), "Sheet1!$C$2:$C$4".to_string()));
        let bytes = workbook(&spec);
        let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut sheet = String::new();
        z.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut sheet).unwrap();
        assert!(sheet.contains(r#"<c r="B1" t="inlineStr"><is><t xml:space="preserve">Series 1</t></is></c>"#));
        assert!(sheet.contains("Q2 &amp; &lt;more&gt;"));
        assert!(sheet.contains(r#"<c r="B2"><v>4.3</v></c>"#));
        assert!(!sheet.contains(r#"r="C4""#), "a gap is an empty cell");
        for part in ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml"] {
            assert!(z.by_name(part).is_ok(), "{part}");
        }
        assert_eq!(column(25), "Z");
        assert_eq!(column(26), "AA");
    }
}
