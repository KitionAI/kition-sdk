//! A small XML tree for Office parts (charts, equations): elements with their attributes and
//! children, text, and everything else (declarations, comments, CDATA, processing instructions)
//! kept verbatim, so a part that is parsed, patched and written back keeps what the patch did not
//! touch. Bounded: depth and size limits keep hostile input from exhausting the stack or memory.

/// Deepest element nesting read.
const MAX_DEPTH: usize = 256;
/// Largest part read, bytes.
pub const MAX_LEN: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Element(Element),
    Text(String),
    /// Kept as written: `<?…?>`, `<!--…-->`, `<![CDATA[…]]>`, `<!…>`.
    Raw(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Element {
    /// The qualified name as written (`c:barChart`).
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
}

impl Element {
    pub fn new(name: &str) -> Self {
        Element { name: name.into(), ..Default::default() }
    }
    pub fn with_attr(mut self, k: &str, v: &str) -> Self {
        self.set_attr(k, v);
        self
    }
    pub fn with_child(mut self, c: Element) -> Self {
        self.children.push(Node::Element(c));
        self
    }
    pub fn with_text(mut self, t: &str) -> Self {
        self.children.push(Node::Text(t.into()));
        self
    }
    pub fn attr(&self, k: &str) -> Option<&str> {
        self.attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
    pub fn set_attr(&mut self, k: &str, v: &str) {
        match self.attrs.iter_mut().find(|(n, _)| n == k) {
            Some(slot) => slot.1 = v.into(),
            None => self.attrs.push((k.into(), v.into())),
        }
    }
    /// The name without its prefix.
    pub fn local(&self) -> &str {
        self.name.rsplit(':').next().unwrap_or(&self.name)
    }
    pub fn elements(&self) -> impl Iterator<Item = &Element> {
        self.children.iter().filter_map(|n| if let Node::Element(e) = n { Some(e) } else { None })
    }
    pub fn elements_mut(&mut self) -> impl Iterator<Item = &mut Element> {
        self.children.iter_mut().filter_map(|n| if let Node::Element(e) = n { Some(e) } else { None })
    }
    /// The first child with local name `local`.
    pub fn child(&self, local: &str) -> Option<&Element> {
        self.elements().find(|e| e.local() == local)
    }
    pub fn child_mut(&mut self, local: &str) -> Option<&mut Element> {
        self.elements_mut().find(|e| e.local() == local)
    }
    /// The child path `a/b/c` by local names.
    pub fn path(&self, path: &str) -> Option<&Element> {
        path.split('/').try_fold(self, |e, p| e.child(p))
    }
    pub fn path_mut(&mut self, path: &str) -> Option<&mut Element> {
        let mut e = self;
        for p in path.split('/') {
            e = e.child_mut(p)?;
        }
        Some(e)
    }
    /// All descendants with local name `local`, depth first.
    pub fn descendants<'a>(&'a self, local: &'a str, out: &mut Vec<&'a Element>) {
        for c in self.elements() {
            if c.local() == local {
                out.push(c);
            }
            c.descendants(local, out);
        }
    }
    pub fn remove_children(&mut self, local: &str) -> usize {
        let before = self.children.len();
        self.children.retain(|n| !matches!(n, Node::Element(e) if e.local() == local));
        before - self.children.len()
    }
    /// The element's text (its text children joined).
    pub fn text(&self) -> String {
        let mut s = String::new();
        for c in &self.children {
            match c {
                Node::Text(t) => s.push_str(t),
                Node::Raw(r) if r.starts_with("<![CDATA[") => s.push_str(r.trim_start_matches("<![CDATA[").trim_end_matches("]]>")),
                _ => {}
            }
        }
        s
    }
    pub fn set_text(&mut self, t: &str) {
        self.children.retain(|n| matches!(n, Node::Element(_)));
        self.children.insert(0, Node::Text(t.into()));
    }
    /// The `val` attribute of child `local`.
    pub fn val(&self, local: &str) -> Option<&str> {
        self.child(local)?.attr("val")
    }
    /// Puts `child` in place of the existing child with its local name, or at `at` (by local
    /// names that must come before it), keeping the schema's order roughly right.
    pub fn put(&mut self, child: Element, after: &[&str]) {
        let local = child.local().to_string();
        if let Some(i) = self.children.iter().position(|n| matches!(n, Node::Element(e) if e.local() == local)) {
            self.children[i] = Node::Element(child);
            return;
        }
        let at = self.children.iter().rposition(|n| matches!(n, Node::Element(e) if after.contains(&e.local()))).map_or(0, |i| i + 1);
        self.children.insert(at, Node::Element(child));
    }
}

/// A parse failure: the part is not well-formed enough to edit.
#[derive(Clone, Debug, PartialEq)]
pub struct XmlError(pub String);

/// An XML element as the Office parts the kits share read them: by the qualified names Office
/// writes (`m:r`, `a:srgbClr`, `dsp:sp`). The kits' own XML trees implement it, so a shared reader
/// works on the tree a kit already has; [`Element`] implements it for parts read here.
pub trait Xml {
    /// The qualified name as written.
    fn qname(&self) -> &str;
    /// An attribute by qualified name; a reader falls back to the unqualified name (some
    /// producers omit the prefix).
    fn qattr(&self, name: &str) -> Option<&str>;
    /// Child elements, in order.
    fn qels(&self) -> Box<dyn Iterator<Item = &Self> + '_>;
    /// The element's own text (its text children joined).
    fn qtext(&self) -> String;
    /// The first child element named `name`.
    fn qchild(&self, name: &str) -> Option<&Self> {
        self.qels().find(|e| e.qname() == name)
    }
    /// The child elements named `name`.
    fn qchildren<'a>(&'a self, name: &'a str) -> Box<dyn Iterator<Item = &'a Self> + 'a> {
        Box::new(self.qels().filter(move |e| e.qname() == name))
    }
    /// The first descendant named `name`, depth first (bounded by [`MAX_DEPTH`]).
    fn qfind(&self, name: &str) -> Option<&Self> {
        fn go<'a, E: Xml + ?Sized>(e: &'a E, name: &str, depth: usize) -> Option<&'a E> {
            if depth > MAX_DEPTH {
                return None;
            }
            for c in e.qels() {
                if c.qname() == name {
                    return Some(c);
                }
                if let Some(f) = go(c, name, depth + 1) {
                    return Some(f);
                }
            }
            None
        }
        go(self, name, 0)
    }
}

impl Xml for Element {
    fn qname(&self) -> &str {
        &self.name
    }
    fn qattr(&self, name: &str) -> Option<&str> {
        if let Some((_, v)) = self.attrs.iter().find(|(k, _)| k == name) {
            return Some(v);
        }
        let local = name.rsplit(':').next().unwrap_or(name);
        if local != name {
            return self.attrs.iter().find(|(k, _)| k == local).map(|(_, v)| v.as_str());
        }
        None
    }
    fn qels(&self) -> Box<dyn Iterator<Item = &Element> + '_> {
        Box::new(self.children.iter().filter_map(|n| match n {
            Node::Element(e) => Some(e),
            _ => None,
        }))
    }
    fn qtext(&self) -> String {
        self.text()
    }
}

/// The document: what precedes the root (declaration, comments) and the root.
#[derive(Clone, Debug, PartialEq)]
pub struct Document {
    pub prolog: Vec<Node>,
    pub root: Element,
}

pub fn parse(src: &str) -> Result<Document, XmlError> {
    if src.len() > MAX_LEN {
        return Err(XmlError("the part is too large".into()));
    }
    let mut p = Parser { s: src.as_bytes(), src, i: 0 };
    let mut prolog = Vec::new();
    loop {
        p.skip_ws_into(&mut prolog);
        if p.i >= p.s.len() {
            return Err(XmlError("no root element".into()));
        }
        if p.starts("<?") || p.starts("<!--") || p.starts("<!") {
            prolog.push(Node::Raw(p.raw()?));
            continue;
        }
        let root = p.element(0)?;
        return Ok(Document { prolog, root });
    }
}

struct Parser<'a> {
    s: &'a [u8],
    src: &'a str,
    i: usize,
}

impl Parser<'_> {
    fn starts(&self, t: &str) -> bool {
        self.s.get(self.i..).is_some_and(|r| r.starts_with(t.as_bytes()))
    }
    fn skip_ws_into(&mut self, _out: &mut [Node]) {
        while self.s.get(self.i).is_some_and(u8::is_ascii_whitespace) {
            self.i += 1;
        }
    }
    fn until(&mut self, end: &str) -> Result<usize, XmlError> {
        let rest = self.src.get(self.i..).ok_or_else(|| XmlError("bad offset".into()))?;
        rest.find(end).map(|k| self.i + k).ok_or_else(|| XmlError(format!("missing `{end}`")))
    }
    fn raw(&mut self) -> Result<String, XmlError> {
        let end = if self.starts("<?") {
            self.until("?>")? + 2
        } else if self.starts("<!--") {
            self.until("-->")? + 3
        } else if self.starts("<![CDATA[") {
            self.until("]]>")? + 3
        } else {
            self.until(">")? + 1
        };
        let r = self.src.get(self.i..end).ok_or_else(|| XmlError("bad markup".into()))?.to_string();
        self.i = end;
        Ok(r)
    }
    fn name(&mut self) -> Result<String, XmlError> {
        let start = self.i;
        while self.s.get(self.i).is_some_and(|c| !c.is_ascii_whitespace() && !matches!(c, b'>' | b'/' | b'=')) {
            self.i += 1;
        }
        if self.i == start {
            return Err(XmlError("a name is missing".into()));
        }
        Ok(self.src.get(start..self.i).unwrap_or_default().to_string())
    }
    fn element(&mut self, depth: usize) -> Result<Element, XmlError> {
        if depth > MAX_DEPTH {
            return Err(XmlError("nested too deeply".into()));
        }
        if !self.starts("<") {
            return Err(XmlError("an element is missing".into()));
        }
        self.i += 1;
        let name = self.name()?;
        let mut e = Element { name, ..Default::default() };
        loop {
            while self.s.get(self.i).is_some_and(u8::is_ascii_whitespace) {
                self.i += 1;
            }
            if self.starts("/>") {
                self.i += 2;
                return Ok(e);
            }
            if self.starts(">") {
                self.i += 1;
                break;
            }
            let k = self.name()?;
            while self.s.get(self.i).is_some_and(u8::is_ascii_whitespace) {
                self.i += 1;
            }
            if !self.starts("=") {
                return Err(XmlError(format!("attribute `{k}` has no value")));
            }
            self.i += 1;
            while self.s.get(self.i).is_some_and(u8::is_ascii_whitespace) {
                self.i += 1;
            }
            let q = *self.s.get(self.i).ok_or_else(|| XmlError("unexpected end".into()))?;
            if q != b'"' && q != b'\'' {
                return Err(XmlError("an attribute value is not quoted".into()));
            }
            self.i += 1;
            let end = self.until(if q == b'"' { "\"" } else { "'" })?;
            let v = unescape(self.src.get(self.i..end).unwrap_or_default());
            self.i = end + 1;
            e.attrs.push((k, v));
        }
        loop {
            if self.i >= self.s.len() {
                return Err(XmlError(format!("`{}` is not closed", e.name)));
            }
            if self.starts("</") {
                self.i += 2;
                let n = self.name()?;
                if n != e.name {
                    return Err(XmlError(format!("`{}` closed by `{n}`", e.name)));
                }
                let end = self.until(">")?;
                self.i = end + 1;
                return Ok(e);
            }
            if self.starts("<!--") || self.starts("<![CDATA[") || self.starts("<?") {
                let r = self.raw()?;
                e.children.push(Node::Raw(r));
                continue;
            }
            if self.starts("<") {
                let c = self.element(depth + 1)?;
                e.children.push(Node::Element(c));
                continue;
            }
            let end = self.until("<")?;
            let t = self.src.get(self.i..end).unwrap_or_default();
            if !t.is_empty() {
                e.children.push(Node::Text(unescape(t)));
            }
            self.i = end;
        }
    }
}

fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(k) = rest.find('&') {
        out.push_str(&rest[..k]);
        rest = &rest[k..];
        let Some(end) = rest.find(';').filter(|e| *e <= 12) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..end];
        let ch = match ent {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => ent
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn escape(s: &str, attr: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' if attr => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

pub fn write(doc: &Document) -> String {
    let mut s = String::new();
    for n in &doc.prolog {
        write_node(n, &mut s);
    }
    write_element(&doc.root, &mut s);
    s
}

fn write_node(n: &Node, s: &mut String) {
    match n {
        Node::Element(e) => write_element(e, s),
        Node::Text(t) => s.push_str(&escape(t, false)),
        Node::Raw(r) => s.push_str(r),
    }
}

fn write_element(e: &Element, s: &mut String) {
    s.push('<');
    s.push_str(&e.name);
    for (k, v) in &e.attrs {
        s.push(' ');
        s.push_str(k);
        s.push_str("=\"");
        s.push_str(&escape(v, true));
        s.push('"');
    }
    if e.children.is_empty() {
        s.push_str("/>");
        return;
    }
    s.push('>');
    for c in &e.children {
        write_node(c, s);
    }
    s.push_str("</");
    s.push_str(&e.name);
    s.push('>');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_keeps_what_it_does_not_model() {
        let src = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="x" xmlns:a="y"><!-- note --><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Q &amp; A &#x4E2D;</a:t></a:r></a:p></c:rich></c:tx></c:title><c:ext uri='{1}'><![CDATA[a<b]]></c:ext></c:chart></c:chartSpace>"#;
        let d = parse(src).unwrap();
        assert_eq!(d.root.path("chart/title/tx/rich/p/r/t").unwrap().text(), "Q & A \u{4E2D}");
        assert_eq!(d.root.path("chart/ext").unwrap().attr("uri"), Some("{1}"));
        let out = write(&d);
        assert_eq!(parse(&out).unwrap(), d);
        assert!(out.contains("<!-- note -->") && out.contains("<![CDATA[a<b]]>"));
    }

    #[test]
    fn rejects_broken_parts() {
        assert!(parse("<a><b></a>").is_err());
        assert!(parse("<a x=1/>").is_err());
        assert!(parse("").is_err());
        let deep = "<a>".repeat(400) + &"</a>".repeat(400);
        assert!(parse(&deep).is_err());
    }
}
