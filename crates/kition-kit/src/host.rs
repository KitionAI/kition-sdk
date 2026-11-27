//! Files the host lends a document: the other files it refers to, such as a film project's
//! media. Reads are synchronous; the engine runs in a Web Worker, where Kition serves them as
//! ranged reads of the workspace, so a long video is never loaded whole.
//!
//! Paths are as the document names them. Kition resolves them inside the workspace (relative
//! paths against the document's folder) and refuses anything outside it, hidden, or the host's
//! own, the same way whether the file exists or not (host contract H3, LR2). A link check asks
//! [`exists`], which tells a missing file from a refused one without reading any message.
//!
//! Natively, tests lend a directory with [`set_root`] and name the document's folder in it with
//! [`set_folder`], with the same resolution rules. A headless kit lends nothing from the file
//! system: [`set_lender`] installs its binding, which asks the host for each path (Kit Process
//! Protocol `storage.resolve`, then `storage.read`).
//!
//! A file the person granted (engine contract E15, KitFiles 1.0) reads the same way, named by its handle
//! (`fh_…`) instead of a path: a command's parameters carry the handle, and the engine passes it
//! back here. The engine never sees the file's path. In the page the binding lends the handle's
//! bytes to the worker before the command runs (`kitionHost`); natively [`set_handles`] installs
//! what answers handles, such as a [`HandleTable`] or the headless binding's `storage.read`.

/// The prefix of a file handle (`fh_`); anything else is a lent path.
pub const HANDLE_PREFIX: &str = "fh_";

/// Whether `file` names a granted file by its handle rather than a lent file by its path.
pub fn is_handle(file: &str) -> bool {
    file.starts_with(HANDLE_PREFIX)
}

/// The size of a lent file in bytes.
pub fn size(path: &str) -> Result<u64, String> {
    imp::size(path)
}

/// Up to `len` bytes of a lent file from `offset` (fewer at the end of the file).
pub fn read_range(path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
    imp::read_range(path, offset, len)
}

/// Whether the lent file `path` is there, for a link check (a broken link, a card whose target is
/// gone): `Ok(true)` when it is, `Ok(false)` when the host says it is not found, which it says only
/// for a path that passes every check of its confinement (Kit Process Protocol `file_not_found`), and
/// `Err` with the host's refusal otherwise, the same whether the file exists or not. A host that
/// cannot tell a missing file from a refused one (one built before `file_not_found`) answers `Err`
/// for both, so an engine reports a missing file only on `Ok(false)` and nothing on `Err`.
pub fn exists(path: &str) -> Result<bool, String> {
    imp::exists(path)
}

/// A whole lent file. Use [`read_range`] for media.
pub fn read(path: &str) -> Result<Vec<u8>, String> {
    let size = usize::try_from(size(path)?).map_err(|_| format!("{path} is too large to read whole"))?;
    read_range(path, 0, size)
}

#[cfg(not(target_arch = "wasm32"))]
pub use imp::{HandleTable, set_folder, set_handles, set_lender, set_root};

/// What answers reads of lent files natively, by the path the document names (a headless
/// binding); it resolves the path against the document itself.
#[cfg(not(target_arch = "wasm32"))]
pub trait LentFiles: Send {
    fn size(&self, path: &str) -> Result<u64, String>;
    fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String>;
    /// [`exists`]: `Ok(false)` only when the host says `path` is not found. A lender that cannot
    /// tell answers by its [`LentFiles::size`], so a missing file is an `Err` as a refused one is.
    fn exists(&self, path: &str) -> Result<bool, String> {
        self.size(path).map(|_| true)
    }
}

/// What answers reads of granted files natively, by handle (engine contract E15).
#[cfg(not(target_arch = "wasm32"))]
pub trait HandleFiles: Send {
    /// The size of the file `handle` names, in bytes.
    fn size(&self, handle: &str) -> Result<u64, String>;
    /// Up to `len` bytes from `offset` (fewer at the end of the file).
    fn read_range(&self, handle: &str, offset: u64, len: usize) -> Result<Vec<u8>, String>;
}

/// `file` as a path under the lent root: relative paths against `folder` (the document's folder,
/// `/`-separated), a leading `/` from the root. `..` may climb only as far as the root. These are
/// the rules Kition's in-page host applies (`resolveLentPath`).
pub fn resolve_lent_path(folder: &str, file: &str) -> Result<String, String> {
    if file.trim().is_empty() || file.ends_with('/') {
        return Err(format!("{} names no file", if file.is_empty() { "an empty path" } else { file }));
    }
    let start = if file.starts_with('/') { "" } else { folder };
    let mut parts: Vec<&str> = Vec::new();
    for part in start.split('/').chain(file.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(format!("{file} is outside the workspace"));
                }
            }
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err(format!("{file} names no file"));
    }
    Ok(parts.join("/"))
}

/// How a host runs the kit's documents (engine contract E22).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Hosting {
    /// A host owns every file (KHP A29, §10.6): the document reaches files only through this
    /// module (lent files, granted handles) and its outputs ([`crate::outputs`]); never the file
    /// system by path, no process it starts, no network, no system font scan. kition-headless
    /// sets it for every kit it serves, before the engine opens anything.
    pub files_only: bool,
}

static FILES_ONLY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Says how a host runs the documents of this process ([`Hosting`]): the headless binding sets it
/// before it opens or creates one, and [`crate::KitDocument::hosted`] tells each document.
pub fn set_hosting(hosting: Hosting) {
    FILES_ONLY.store(hosting.files_only, std::sync::atomic::Ordering::SeqCst);
}

/// How a host runs the documents of this process; the default (nothing set) in the page's worker
/// and in a kit's own tests. An engine reads it where a constructor cannot be told, such as while
/// [`crate::KitDocument::open`] reads the file.
#[must_use]
pub fn hosting() -> Hosting {
    Hosting { files_only: FILES_ONLY.load(std::sync::atomic::Ordering::SeqCst) }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use std::io::{Read, Seek, SeekFrom};
    use std::path::{Component, PathBuf};
    use std::sync::{Mutex, PoisonError};

    use std::collections::HashMap;

    use super::{HandleFiles, LentFiles};

    static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);
    static LENDER: Mutex<Option<Box<dyn LentFiles>>> = Mutex::new(None);
    static FOLDER: Mutex<String> = Mutex::new(String::new());
    static HANDLES: Mutex<Option<Box<dyn HandleFiles>>> = Mutex::new(None);

    /// Answers reads of granted files with `handles` (a headless binding, a test's
    /// [`HandleTable`]); `None` grants nothing, so every handle is an error.
    pub fn set_handles(handles: Option<Box<dyn HandleFiles>>) {
        *HANDLES.lock().unwrap_or_else(PoisonError::into_inner) = handles;
    }

    fn with_handles<T>(handle: &str, read: impl FnOnce(&dyn HandleFiles) -> Result<T, String>) -> Result<T, String> {
        let handles = HANDLES.lock().unwrap_or_else(PoisonError::into_inner);
        let handles = handles.as_deref().ok_or_else(|| format!("{handle} was not granted to this kit"))?;
        read(handles)
    }

    /// Granted files as local files, by handle: what a test or a native host that resolved the
    /// person's choice to a file installs with [`set_handles`].
    #[derive(Debug, Default)]
    pub struct HandleTable {
        files: HashMap<String, PathBuf>,
    }

    impl HandleTable {
        /// Grants `file` to the engine as `handle`.
        #[must_use]
        pub fn grant(mut self, handle: &str, file: PathBuf) -> Self {
            self.files.insert(handle.to_owned(), file);
            self
        }

        fn file(&self, handle: &str) -> Result<&PathBuf, String> {
            self.files.get(handle).ok_or_else(|| format!("{handle} was not granted to this kit"))
        }
    }

    impl HandleFiles for HandleTable {
        fn size(&self, handle: &str) -> Result<u64, String> {
            std::fs::metadata(self.file(handle)?).map(|meta| meta.len()).map_err(|error| format!("{handle}: {}", error.kind()))
        }

        fn read_range(&self, handle: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
            read_file_range(self.file(handle)?, handle, offset, len)
        }
    }

    fn read_file_range(path: &std::path::Path, name: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        let mut file = std::fs::File::open(path).map_err(|error| format!("{name}: {}", error.kind()))?;
        file.seek(SeekFrom::Start(offset)).map_err(|error| format!("{name}: {}", error.kind()))?;
        let mut out = Vec::new();
        file.take(len as u64).read_to_end(&mut out).map_err(|error| format!("{name}: {}", error.kind()))?;
        Ok(out)
    }

    /// Answers reads of lent files with `lender` instead of a lent root; `None` removes it.
    pub fn set_lender(lender: Option<Box<dyn LentFiles>>) {
        *LENDER.lock().unwrap_or_else(PoisonError::into_inner) = lender;
    }

    /// `Some` answer of the installed lender, `None` when there is none.
    fn with_lender<T>(read: impl FnOnce(&dyn LentFiles) -> Result<T, String>) -> Option<Result<T, String>> {
        let lender = LENDER.lock().unwrap_or_else(PoisonError::into_inner);
        lender.as_deref().map(read)
    }

    /// Lends the files under `root` (native tests); `None` lends nothing.
    pub fn set_root(root: Option<PathBuf>) {
        *ROOT.lock().unwrap_or_else(PoisonError::into_inner) = root;
    }

    /// The document's folder under the root (`/`-separated, empty for the root itself): relative
    /// paths the document names resolve against it.
    pub fn set_folder(folder: &str) {
        *FOLDER.lock().unwrap_or_else(PoisonError::into_inner) = folder.to_owned();
    }

    /// `path` under the lent root, refused when it climbs out of it or has a hidden segment (LR2),
    /// with every check that needs no file system done.
    fn lexical(path: &str) -> Result<(PathBuf, PathBuf), String> {
        let root = ROOT.lock().unwrap_or_else(PoisonError::into_inner).clone().ok_or("this host lends no files")?;
        let folder = FOLDER.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let relative = super::resolve_lent_path(&folder, path)?;
        if relative.split('/').any(|part| part.starts_with('.')) {
            return Err(format!("{path} is not lent: it is hidden"));
        }
        let resolved = relative.split('/').fold(root.clone(), |at, part| at.join(part));
        if resolved.components().any(|part| matches!(part, Component::ParentDir)) {
            return Err(format!("{path} is outside the lent files"));
        }
        Ok((root, resolved))
    }

    /// Whether `entry`, which exists, is inside `root` once links are followed, and not hidden.
    fn reaches(root: &std::path::Path, entry: &std::path::Path) -> bool {
        let (Ok(real), Ok(real_root)) = (entry.canonicalize(), root.canonicalize()) else { return false };
        real.strip_prefix(&real_root).is_ok_and(|inside| !inside.components().any(|part| part.as_os_str().to_string_lossy().starts_with('.')))
    }

    /// `path` as a lent file: `Some` when it exists and may be read, `None` when it passes every
    /// check and is not there (its nearest existing folder inside the root), refused otherwise,
    /// the same whether it exists or not.
    fn look_up(path: &str) -> Result<Option<PathBuf>, String> {
        let (root, resolved) = lexical(path)?;
        let outside = || format!("{path} is outside the lent files");
        if std::fs::symlink_metadata(&resolved).is_ok() {
            // A symbolic link must not lead out of the root.
            return if reaches(&root, &resolved) { Ok(Some(resolved)) } else { Err(outside()) };
        }
        let folder = resolved.ancestors().skip(1).find(|folder| std::fs::symlink_metadata(folder).is_ok()).ok_or_else(outside)?;
        if reaches(&root, folder) && folder.is_dir() { Ok(None) } else { Err(outside()) }
    }

    fn resolve(path: &str) -> Result<PathBuf, String> {
        look_up(path)?.ok_or_else(|| format!("{path}: {}", std::io::ErrorKind::NotFound))
    }

    pub fn exists(path: &str) -> Result<bool, String> {
        if super::is_handle(path) {
            return with_handles(path, |handles| handles.size(path)).map(|_| true);
        }
        if let Some(answer) = with_lender(|lender| lender.exists(path)) {
            return answer;
        }
        look_up(path).map(|found| found.is_some())
    }

    pub fn size(path: &str) -> Result<u64, String> {
        if super::is_handle(path) {
            return with_handles(path, |handles| handles.size(path));
        }
        if let Some(answer) = with_lender(|lender| lender.size(path)) {
            return answer;
        }
        std::fs::metadata(resolve(path)?).map(|meta| meta.len()).map_err(|error| format!("{path}: {}", error.kind()))
    }

    pub fn read_range(path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        if super::is_handle(path) {
            return with_handles(path, |handles| handles.read_range(path, offset, len));
        }
        if let Some(answer) = with_lender(|lender| lender.read_range(path, offset, len)) {
            return answer;
        }
        read_file_range(&resolve(path)?, path, offset, len)
    }
}

#[cfg(target_arch = "wasm32")]
mod imp {
    use wasm_bindgen::prelude::*;

    // `globalThis.kitionHost`, which the kit worker defines (`@kition/kit-editor`'s
    // `lentFiles.ts`); it serves handles from the bytes the binding lent it.
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = kitionHost, js_name = size, catch)]
        fn host_size(path: &str) -> Result<f64, JsValue>;
        #[wasm_bindgen(js_namespace = kitionHost, js_name = readRange, catch)]
        fn host_read_range(path: &str, offset: f64, len: u32) -> Result<Vec<u8>, JsValue>;
        // `true` or `false` as `host::exists` answers, or a thrown refusal; a binding without it
        // throws, which makes every answer an error (the host cannot tell).
        #[wasm_bindgen(js_namespace = kitionHost, js_name = exists, catch)]
        fn host_exists(path: &str) -> Result<bool, JsValue>;
    }

    // Kition's host throws plain strings, so the message survives the boundary.
    fn message(error: JsValue) -> String {
        error.as_string().unwrap_or_else(|| "this host lends no files".to_owned())
    }

    pub fn size(path: &str) -> Result<u64, String> {
        let size = host_size(path).map_err(message)?;
        if size.is_finite() && size >= 0.0 { Ok(size as u64) } else { Err(format!("{path}: the host reported no size")) }
    }

    pub fn read_range(path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        let len = u32::try_from(len).map_err(|_| format!("{path}: read too large"))?;
        host_read_range(path, offset as f64, len).map_err(message)
    }

    pub fn exists(path: &str) -> Result<bool, String> {
        host_exists(path).map_err(message)
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    /// The lent root and the handles are process-wide: the tests that set them take turns.
    static GLOBALS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Engine contract E22: nothing is hosted until a host says so (the page, a kit's tests).
    #[test]
    fn a_host_says_it_owns_every_file() {
        let _turn = GLOBALS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(hosting(), Hosting::default());
        set_hosting(Hosting { files_only: true });
        assert!(hosting().files_only);
        set_hosting(Hosting::default());
    }

    #[test]
    fn resolves_like_the_in_page_host() {
        assert_eq!(resolve_lent_path("films", "clips/a.mp4").unwrap(), "films/clips/a.mp4");
        assert_eq!(resolve_lent_path("films/cuts", "../clips/a.mp4").unwrap(), "films/clips/a.mp4");
        assert_eq!(resolve_lent_path("films", "/a.mp4").unwrap(), "a.mp4");
        assert_eq!(resolve_lent_path("", "./a/./b.png").unwrap(), "a/b.png");
        assert!(resolve_lent_path("films", "../../a.mp4").is_err());
        assert!(resolve_lent_path("films", "").is_err());
        assert!(resolve_lent_path("films", "clips/").is_err());
    }

    #[test]
    fn lends_files_under_the_root_only() {
        let _turn = GLOBALS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("kition-sdk-host-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("media")).unwrap();
        std::fs::write(dir.join("media/a.bin"), b"0123456789").unwrap();
        set_root(None);
        assert!(size("media/a.bin").is_err());
        set_root(Some(dir.clone()));
        assert_eq!(size("media/a.bin").unwrap(), 10);
        assert_eq!(read_range("media/a.bin", 3, 4).unwrap(), b"3456");
        assert_eq!(read_range("media/a.bin", 8, 10).unwrap(), b"89");
        assert_eq!(read("/media/a.bin").unwrap(), b"0123456789");
        assert!(read("../etc/passwd").is_err());
        // Relative to the document's folder, climbing no higher than the root.
        set_folder("media/sub");
        assert_eq!(read("../a.bin").unwrap(), b"0123456789");
        assert!(read("../../../a.bin").is_err());
        assert_eq!(read("/media/a.bin").unwrap(), b"0123456789");
        set_folder("");
        set_root(None);
        let _ = std::fs::remove_dir_all(dir);
    }

    // regressions/issue-file-not-found: `exists` is `false` only for a missing file the kit may
    // see; a path outside the lent files, through a hidden segment, or through a link out of them
    // is refused, and refused alike whether its target exists or not (H3, LR2).
    #[test]
    fn exists_tells_a_missing_lent_file_from_a_refused_one() {
        let _turn = GLOBALS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("kition-sdk-exists-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("kition-sdk-exists-outside-{}", std::process::id()));
        for folder in [dir.join("media"), dir.join(".hidden"), outside.clone()] {
            std::fs::create_dir_all(folder).unwrap();
        }
        std::fs::write(dir.join("media/a.bin"), b"A").unwrap();
        std::fs::write(dir.join(".hidden/x"), b"X").unwrap();
        std::fs::write(outside.join("x"), b"X").unwrap();
        let mut pairs = vec![("../x", "../nothing"), (".hidden/x", ".hidden/nothing"), ("media/.hidden-x", "media/.nothing")];
        std::fs::write(dir.join("media/.hidden-x"), b"X").unwrap();
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(dir.join("media/out"));
            std::os::unix::fs::symlink(&outside, dir.join("media/out")).unwrap();
            pairs.push(("media/out/x", "media/out/nothing"));
        }
        set_root(Some(dir.clone()));
        set_folder("");
        assert_eq!(exists("media/a.bin"), Ok(true));
        assert_eq!(exists("media/missing.bin"), Ok(false));
        assert_eq!(exists("gone/missing.bin"), Ok(false), "a missing folder inside the lent files");
        for (existing, missing) in pairs {
            let (existing_error, missing_error) = (exists(existing).unwrap_err(), exists(missing).unwrap_err());
            assert_eq!(existing_error.replace(existing, missing), missing_error, "{existing} and {missing} are refused alike");
            assert!(read(existing).is_err(), "{existing} is not read either");
        }
        set_root(None);
        let _ = (std::fs::remove_dir_all(dir), std::fs::remove_dir_all(outside));
    }

    #[test]
    fn a_lender_answers_paths_instead_of_the_root() {
        struct Echo;
        impl LentFiles for Echo {
            fn size(&self, path: &str) -> Result<u64, String> {
                Ok(path.len() as u64)
            }
            fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
                Ok(path.as_bytes().iter().skip(offset as usize).take(len).copied().collect())
            }
        }
        let _turn = GLOBALS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        set_root(None);
        set_lender(Some(Box::new(Echo)));
        // The path goes to the lender as the document names it, `..` and all.
        assert_eq!(read("../media/a.png").unwrap(), b"../media/a.png");
        assert_eq!(size("a").unwrap(), 1);
        // A lender that cannot say "not found" answers `exists` by reading the size.
        assert_eq!(exists("a"), Ok(true));
        set_lender(None);
        assert!(read("a").is_err());
    }

    #[test]
    fn reads_granted_files_by_handle_only() {
        let _turn = GLOBALS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("kition-sdk-handles-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("in.csv"), b"a,b\n1,2\n").unwrap();
        assert!(is_handle("fh_1") && !is_handle("media/fh_1"));
        set_handles(None);
        assert!(size("fh_1").unwrap_err().contains("not granted"));
        set_handles(Some(Box::new(HandleTable::default().grant("fh_1", dir.join("in.csv")))));
        assert_eq!(size("fh_1").unwrap(), 8);
        assert_eq!(read_range("fh_1", 4, 3).unwrap(), b"1,2");
        assert_eq!(read("fh_1").unwrap(), b"a,b\n1,2\n");
        assert!(read("fh_2").unwrap_err().contains("not granted"));
        // A handle never falls back to a lent path of the same name.
        set_root(Some(dir.clone()));
        assert!(read("fh_2").is_err());
        set_root(None);
        set_handles(None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
