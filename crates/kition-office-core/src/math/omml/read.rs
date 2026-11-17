//! OMML → math tree.

use crate::math::{Arg, BrkBin, BrkBinSub, ColJc, FracKind, LimLoc, MAX_DEPTH, MNode, MRun, MScr, MSty, MathJc, MathProps, ScriptKind, merge_runs};
use crate::model::Rgb;
use crate::xml::Xml;

/// The nodes of an `m:oMath` element (or any math container: `m:e`, `m:num`…).
pub fn read<E: Xml>(e: &E) -> Arg {
    merge_runs(arg(e, 0))
}

/// A length in twips (or with a unit) → points.
fn tw<E: Xml>(e: &E, attr: &str) -> Option<f32> {
    let t = e.qattr(attr)?.trim();
    if t.is_empty() || t.len() > 40 {
        return None;
    }
    let split = t.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')).unwrap_or(t.len());
    let (num, unit) = t.split_at(split);
    let v: f64 = num.parse().ok()?;
    let pt = match unit.trim() {
        "" => v / 20.0,
        "pt" => v,
        "in" => v * 72.0,
        "cm" => v * 72.0 / 2.54,
        "mm" => v * 72.0 / 25.4,
        "pc" | "pi" => v * 12.0,
        "px" => v * 0.75,
        _ => return None,
    } as f32;
    pt.is_finite().then_some(pt)
}

/// ST_OnOff in `w:val`: absent = on; `0`, `false`, `off` = off.
fn on_off_w<E: Xml>(e: &E) -> bool {
    match e.qattr("w:val") {
        None => true,
        Some(v) => !matches!(v.trim(), "0" | "false" | "off" | "False" | "FALSE"),
    }
}

/// `m:oMathParaPr/m:jc`.
pub fn para_jc<E: Xml>(para: &E) -> MathJc {
    match para.qchild("m:oMathParaPr").and_then(|p| p.qchild("m:jc")).and_then(|j| j.qattr("m:val")) {
        Some("left") => MathJc::Left,
        Some("right") => MathJc::Right,
        Some("center") => MathJc::Center,
        _ => MathJc::CenterGroup,
    }
}

/// The settings part's `m:mathPr`: how display equations wrap.
pub fn read_math_pr<E: Xml>(e: &E) -> MathProps {
    let mut m = MathProps::default();
    let pr = Some(e);
    m.brk_bin = match val(pr, "m:brkBin") {
        Some("after") => BrkBin::After,
        Some("repeat") => BrkBin::Repeat,
        _ => BrkBin::Before,
    };
    m.brk_bin_sub = match val(pr, "m:brkBinSub") {
        Some("-+") => BrkBinSub::MinusPlus,
        Some("+-") => BrkBinSub::PlusMinus,
        _ => BrkBinSub::MinusMinus,
    };
    if let Some(v) = e.qchild("m:wrapIndent").and_then(|c| tw(c, "m:val")).filter(|v| v.is_finite() && *v >= 0.0) {
        m.wrap_indent = v.min(1584.0);
    }
    m.wrap_right = prop(pr, "m:wrapRight", false);
    m
}

/// OMML on/off property: absent `m:val` = on.
fn on<E: Xml>(e: &E) -> bool {
    match e.qattr("m:val") {
        None => true,
        Some(v) => !matches!(v.trim(), "0" | "false" | "off" | "False" | "FALSE"),
    }
}

/// An on/off property `name` in the properties element `pr` (absent = `default`).
fn prop<E: Xml>(pr: Option<&E>, name: &str, default: bool) -> bool {
    pr.and_then(|p| p.qchild(name)).map(on).unwrap_or(default)
}

/// A character property (`m:chr`, `m:begChr`…): `None` when absent, `Some(None)` when empty.
fn chr<E: Xml>(pr: Option<&E>, name: &str) -> Option<Option<char>> {
    let c = pr?.qchild(name)?;
    match c.qattr("m:val") {
        Some(v) => Some(v.chars().next()),
        None => Some(None),
    }
}

fn val<'a, E: Xml>(pr: Option<&'a E>, name: &str) -> Option<&'a str> {
    pr.and_then(|p| p.qchild(name)).and_then(|c| c.qattr("m:val"))
}

/// The argument held by child `name` of `e`.
fn sub_arg<E: Xml>(e: &E, name: &str, depth: usize) -> Arg {
    e.qchild(name).map(|c| arg(c, depth + 1)).unwrap_or_default()
}

/// Read the math content of an element (`m:oMath`, `m:e`, `m:num`…).
fn arg<E: Xml>(e: &E, depth: usize) -> Arg {
    let mut out = Vec::new();
    if depth > MAX_DEPTH {
        return out;
    }
    for k in e.qels() {
        node(k, depth, &mut out);
    }
    out
}

fn node<E: Xml>(k: &E, depth: usize, out: &mut Arg) {
    let d = depth + 1;
    match k.qname() {
        "m:r" => {
            if let Some(r) = run(k) {
                out.push(MNode::Run(r));
            }
        }
        // Word puts ordinary runs in math zones for normal text in some files.
        "w:r" => {
            let text = run_text(k);
            if !text.is_empty() {
                let mut r = MRun { text, nor: true, sty: Some(MSty::Plain), ..Default::default() };
                wrpr(k.qchild("w:rPr"), &mut r);
                out.push(MNode::Run(r));
            }
        }
        "m:f" => {
            let pr = k.qchild("m:fPr");
            let kind = match val(pr, "m:type") {
                Some("skw") => FracKind::Skewed,
                Some("lin") => FracKind::Linear,
                Some("noBar") => FracKind::NoBar,
                _ => FracKind::Bar,
            };
            out.push(MNode::Frac { kind, num: sub_arg(k, "m:num", d), den: sub_arg(k, "m:den", d) });
        }
        "m:sSup" => out.push(MNode::Script { kind: ScriptKind::Sup, base: sub_arg(k, "m:e", d), sub: Vec::new(), sup: sub_arg(k, "m:sup", d) }),
        "m:sSub" => out.push(MNode::Script { kind: ScriptKind::Sub, base: sub_arg(k, "m:e", d), sub: sub_arg(k, "m:sub", d), sup: Vec::new() }),
        "m:sSubSup" => {
            out.push(MNode::Script { kind: ScriptKind::SubSup, base: sub_arg(k, "m:e", d), sub: sub_arg(k, "m:sub", d), sup: sub_arg(k, "m:sup", d) })
        }
        "m:sPre" => out.push(MNode::Script { kind: ScriptKind::Pre, base: sub_arg(k, "m:e", d), sub: sub_arg(k, "m:sub", d), sup: sub_arg(k, "m:sup", d) }),
        "m:rad" => {
            let pr = k.qchild("m:radPr");
            out.push(MNode::Rad { deg: sub_arg(k, "m:deg", d), deg_hide: prop(pr, "m:degHide", false), e: sub_arg(k, "m:e", d) });
        }
        "m:nary" => {
            let pr = k.qchild("m:naryPr");
            let chr = chr(pr, "m:chr").map(|c| c.unwrap_or('∫')).unwrap_or('∫');
            let lim_loc = match val(pr, "m:limLoc") {
                Some("undOvr") => Some(LimLoc::UndOvr),
                Some("subSup") => Some(LimLoc::SubSup),
                _ => None,
            };
            out.push(MNode::Nary {
                chr,
                lim_loc,
                grow: prop(pr, "m:grow", false),
                sub_hide: prop(pr, "m:subHide", false),
                sup_hide: prop(pr, "m:supHide", false),
                sub: sub_arg(k, "m:sub", d),
                sup: sub_arg(k, "m:sup", d),
                e: sub_arg(k, "m:e", d),
            });
        }
        "m:d" => {
            let pr = k.qchild("m:dPr");
            let beg = chr(pr, "m:begChr").unwrap_or(Some('('));
            let end = chr(pr, "m:endChr").unwrap_or(Some(')'));
            let sep = chr(pr, "m:sepChr").unwrap_or(Some('|'));
            let elems: Vec<Arg> = k.qchildren("m:e").map(|e| arg(e, d)).collect();
            out.push(MNode::Delim {
                beg,
                end,
                sep,
                grow: prop(pr, "m:grow", true),
                shp_match: val(pr, "m:shp") == Some("match"),
                elems: if elems.is_empty() { vec![Vec::new()] } else { elems },
            });
        }
        "m:func" => out.push(MNode::Func { name: sub_arg(k, "m:fName", d), e: sub_arg(k, "m:e", d) }),
        "m:limLow" => out.push(MNode::Lim { upper: false, e: sub_arg(k, "m:e", d), lim: sub_arg(k, "m:lim", d) }),
        "m:limUpp" => out.push(MNode::Lim { upper: true, e: sub_arg(k, "m:e", d), lim: sub_arg(k, "m:lim", d) }),
        "m:acc" => {
            let c = chr(k.qchild("m:accPr"), "m:chr").map(|c| c.unwrap_or('\u{302}')).unwrap_or('\u{302}');
            out.push(MNode::Acc { chr: c, e: sub_arg(k, "m:e", d) });
        }
        "m:bar" => out.push(MNode::Bar { top: val(k.qchild("m:barPr"), "m:pos") == Some("top"), e: sub_arg(k, "m:e", d) }),
        "m:borderBox" => {
            let pr = k.qchild("m:borderBoxPr");
            out.push(MNode::BorderBox {
                hide: [prop(pr, "m:hideTop", false), prop(pr, "m:hideBot", false), prop(pr, "m:hideLeft", false), prop(pr, "m:hideRight", false)],
                strike: [prop(pr, "m:strikeH", false), prop(pr, "m:strikeV", false), prop(pr, "m:strikeBLTR", false), prop(pr, "m:strikeTLBR", false)],
                e: sub_arg(k, "m:e", d),
            });
        }
        "m:box" => out.push(MNode::Boxed { e: sub_arg(k, "m:e", d) }),
        "m:groupChr" => {
            let pr = k.qchild("m:groupChrPr");
            let c = chr(pr, "m:chr").map(|c| c.unwrap_or('\u{23DF}')).unwrap_or('\u{23DF}');
            out.push(MNode::GroupChr { chr: c, top: val(pr, "m:pos") == Some("top"), e: sub_arg(k, "m:e", d) });
        }
        "m:eqArr" => out.push(MNode::EqArr { rows: k.qchildren("m:e").map(|e| arg(e, d)).collect() }),
        "m:m" => {
            let mut col_jc = Vec::new();
            if let Some(mcs) = k.qchild("m:mPr").and_then(|p| p.qchild("m:mcs")) {
                for mc in mcs.qchildren("m:mc") {
                    let pr = mc.qchild("m:mcPr");
                    let jc = match val(pr, "m:mcJc") {
                        Some("left") => ColJc::Left,
                        Some("right") => ColJc::Right,
                        _ => ColJc::Center,
                    };
                    let count = val(pr, "m:count").and_then(|c| c.trim().parse::<usize>().ok()).unwrap_or(1).clamp(1, 64);
                    for _ in 0..count {
                        if col_jc.len() < 64 {
                            col_jc.push(jc);
                        }
                    }
                }
            }
            let rows = k.qchildren("m:mr").take(1000).map(|r| r.qchildren("m:e").take(64).map(|e| arg(e, d)).collect()).collect();
            out.push(MNode::Matrix { rows, col_jc });
        }
        "m:phant" => {
            let pr = k.qchild("m:phantPr");
            out.push(MNode::Phant {
                show: prop(pr, "m:show", true),
                zero_wid: prop(pr, "m:zeroWid", false),
                zero_asc: prop(pr, "m:zeroAsc", false),
                zero_desc: prop(pr, "m:zeroDesc", false),
                e: sub_arg(k, "m:e", d),
            });
        }
        // Tracked insertions show; deletions don't.
        "w:ins" | "w:moveTo" | "w:smartTag" | "w:customXml" | "m:oMath" if depth <= MAX_DEPTH => {
            for c in k.qels() {
                node(c, d, out);
            }
        }
        "w:sdt" => {
            if let Some(c) = k.qchild("w:sdtContent") {
                for c in c.qels() {
                    node(c, d, out);
                }
            }
        }
        _ => {}
    }
}

/// `m:t` (and `w:t`) text of a run.
fn run_text<E: Xml>(r: &E) -> String {
    let mut s = String::new();
    for c in r.qels() {
        match c.qname() {
            "m:t" | "w:t" => s.push_str(&c.qtext()),
            "w:tab" => s.push('\t'),
            _ => {}
        }
    }
    s
}

fn run<E: Xml>(r: &E) -> Option<MRun> {
    let text = run_text(r);
    if text.is_empty() {
        return None;
    }
    let mut out = MRun { text, ..Default::default() };
    if let Some(pr) = r.qchild("m:rPr") {
        out.sty = match pr.qchild("m:sty").and_then(|s| s.qattr("m:val")) {
            Some("p") => Some(MSty::Plain),
            Some("b") => Some(MSty::Bold),
            Some("i") => Some(MSty::Italic),
            Some("bi") => Some(MSty::BoldItalic),
            _ => None,
        };
        out.scr = match pr.qchild("m:scr").and_then(|s| s.qattr("m:val")) {
            Some("script") => MScr::Script,
            Some("fraktur") => MScr::Fraktur,
            Some("double-struck") => MScr::DoubleStruck,
            Some("sans-serif") => MScr::SansSerif,
            Some("monospace") => MScr::Monospace,
            _ => MScr::Roman,
        };
        out.nor = pr.qchild("m:nor").is_some_and(on);
        out.lit = pr.qchild("m:lit").is_some_and(on);
        if let Some(b) = pr.qchild("m:brk") {
            let aln = b.qattr("m:alnAt").and_then(|v| v.trim().parse::<u32>().ok()).unwrap_or(0);
            out.brk = Some(aln.min(255) as u8);
        }
    }
    wrpr(r.qchild("w:rPr"), &mut out);
    arpr(r.qchild("a:rPr"), &mut out);
    Some(out)
}

/// The run formatting a math run takes from `w:rPr`: size, colour, normal-text font and weight.
fn wrpr<E: Xml>(pr: Option<&E>, out: &mut MRun) {
    let Some(pr) = pr else { return };
    if let Some(sz) = pr.qchild("w:sz").and_then(|s| s.qattr("w:val")).and_then(|v| v.trim().parse::<f32>().ok()) {
        let pt = sz / 2.0;
        if pt.is_finite() && (1.0..=1638.0).contains(&pt) {
            out.size = Some(pt);
        }
    }
    if let Some(c) = pr.qchild("w:color").and_then(|c| c.qattr("w:val")).and_then(Rgb::parse) {
        out.color = Some(c);
    }
    if out.nor {
        if let Some(f) = pr.qchild("w:rFonts").and_then(|f| f.qattr("w:ascii").or_else(|| f.qattr("w:hAnsi"))) {
            out.font = Some(f.to_string());
        }
        let bold = pr.qchild("w:b").is_some_and(on_off_w);
        let italic = pr.qchild("w:i").is_some_and(on_off_w);
        if bold || italic {
            out.sty = Some(match (bold, italic) {
                (true, true) => MSty::BoldItalic,
                (true, false) => MSty::Bold,
                _ => MSty::Italic,
            });
        }
    }
}

/// The run formatting a math run takes from DrawingML `a:rPr` (equations in presentations): size
/// in hundredths of a point, a solid fill's colour, and a normal-text run's font and weight.
fn arpr<E: Xml>(pr: Option<&E>, out: &mut MRun) {
    let Some(pr) = pr else { return };
    if let Some(sz) = pr.qattr("sz").and_then(|v| v.trim().parse::<f32>().ok()) {
        let pt = sz / 100.0;
        if pt.is_finite() && (1.0..=4000.0).contains(&pt) {
            out.size = Some(pt);
        }
    }
    if let Some(c) = pr.qchild("a:solidFill").and_then(|f| f.qchild("a:srgbClr")).and_then(|c| c.qattr("val")).and_then(Rgb::parse) {
        out.color = Some(c);
    }
    if out.nor {
        if let Some(f) = pr.qchild("a:latin").and_then(|f| f.qattr("typeface")).filter(|f| !f.is_empty()) {
            out.font = Some(f.to_string());
        }
        let on = |name: &str| pr.qattr(name).is_some_and(|v| matches!(v.trim(), "1" | "true"));
        let (bold, italic) = (on("b"), on("i"));
        if bold || italic {
            out.sty = Some(match (bold, italic) {
                (true, true) => MSty::BoldItalic,
                (true, false) => MSty::Bold,
                _ => MSty::Italic,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn omath(inner: &str) -> crate::xml::Element {
        let x = format!(
            r#"<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">{inner}</m:oMath>"#
        );
        crate::xml::parse(&x).unwrap().root
    }

    #[test]
    fn reads_fraction_radical_and_scripts() {
        let e = omath(
            r#"<m:r><m:t>x=</m:t></m:r><m:f><m:num><m:r><m:t>-b±</m:t></m:r><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:sSup><m:e><m:r><m:t>b</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup><m:r><m:t>-4ac</m:t></m:r></m:e></m:rad></m:num><m:den><m:r><m:t>2a</m:t></m:r></m:den></m:f>"#,
        );
        let m = crate::math::Math { nodes: read(&e), ..Default::default() };
        assert_eq!(m.nodes.len(), 2);
        let MNode::Frac { num, den, kind } = &m.nodes[1] else { panic!("{:#?}", m.nodes) };
        assert_eq!(*kind, FracKind::Bar);
        assert_eq!(den, &vec![MNode::Run(MRun::new("2a"))]);
        let MNode::Rad { deg_hide, e, .. } = &num[1] else { panic!() };
        assert!(*deg_hide);
        assert!(matches!(e[0], MNode::Script { kind: ScriptKind::Sup, .. }));
        assert_eq!(crate::math::to_linear(&m.nodes), "x=(-b±√(b^2-4ac))/2a");
    }

    #[test]
    fn reads_nary_delims_matrix_and_defaults() {
        let e = omath(
            r#"<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub><m:r><m:t>i</m:t></m:r></m:sub><m:sup/><m:e><m:r><m:t>i</m:t></m:r></m:e></m:nary><m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val=""/></m:dPr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:d><m:nary><m:e/></m:nary><m:m><m:mr><m:e/><m:e/></m:mr></m:m>"#,
        );
        let m = crate::math::Math { nodes: read(&e), ..Default::default() };
        let MNode::Nary { chr, lim_loc, .. } = &m.nodes[0] else { panic!() };
        assert_eq!((*chr, *lim_loc), ('∑', Some(LimLoc::UndOvr)));
        let MNode::Delim { beg, end, sep, elems, .. } = &m.nodes[1] else { panic!() };
        assert_eq!((*beg, *end, *sep, elems.len()), (Some('['), None, Some('|'), 2));
        assert!(matches!(m.nodes[2], MNode::Nary { chr: '∫', .. }));
        assert!(matches!(&m.nodes[3], MNode::Matrix { rows, .. } if rows.len() == 1 && rows[0].len() == 2));
    }

    #[test]
    fn presentation_runs_take_drawingml_formatting() {
        // PowerPoint's a14:m: each math run carries a:rPr (size in hundredths, a solid fill).
        let x = r#"<m:oMath><m:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><m:t>x</m:t></m:r><m:r><m:rPr><m:nor/></m:rPr><a:rPr sz="1800" b="1"><a:latin typeface="Inter"/></a:rPr><m:t>if</m:t></m:r></m:oMath>"#;
        let nodes = read(&crate::xml::parse(x).unwrap().root);
        let [MNode::Run(a), MNode::Run(b)] = nodes.as_slice() else { panic!("{nodes:?}") };
        assert_eq!((a.size, a.color), (Some(24.0), Some(Rgb(0xC0, 0, 0))));
        assert_eq!((b.size, b.font.as_deref(), b.sty), (Some(18.0), Some("Inter"), Some(MSty::Bold)));
    }
}
