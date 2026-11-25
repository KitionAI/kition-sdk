//! `document.identity` and `document.fork` (protocol section 5.6): the permanent document id
//! (KDM `DocId`, KitModel M7) a file carries, and the file as a new document (M7a).
//!
//! A kit says how its files carry a document with [`KitBackend::file_identity`]
//! (crate::KitBackend::file_identity): [`FileIdentity::NotEmbedded`] when its files hold no replica
//! (it rebuilds one on open), which this crate answers on its own, or
//! [`FileIdentity::Embedded`] with an [`EmbeddedReplica`] that only finds the replica's bytes in the
//! kit's container and writes others in their place. This crate loads the replica, reads its id and
//! makes the copy (`Replica::copy_as_new_document`: no history, the same object ids); the kit's code
//! never touches KDM for it.

use std::sync::Arc;

use kition_kdm::{ActorId, DocId, Replica, Schema};

use crate::protocol::{ErrorReason, RpcError};

/// How a kit's files carry their document's identity.
#[derive(Clone)]
pub enum FileIdentity {
    /// The files embed no replica: the kit makes one when it opens a file, under a new id each
    /// time. A file carries no identity, and a fork is the same bytes.
    NotEmbedded,
    /// The files embed the document's replica (a KDM snapshot), so a copy of the bytes is the same
    /// document.
    Embedded(Arc<dyn EmbeddedReplica>),
}

/// Where a kit's container keeps its replica. Both methods work on a whole file's bytes and never
/// change anything else in it.
pub trait EmbeddedReplica: Send + Sync {
    /// The schema the replica is of (the kit's `model/schema.json`).
    fn schema(&self) -> Arc<Schema>;
    /// The replica's bytes (KDM content, `Replica::content_snapshot`) in `file`, or `None` when this
    /// file holds none (a file another program wrote, one the kit has not saved yet). An error
    /// says the file is not one of the kit's.
    fn replica(&self, file: &[u8]) -> Result<Option<Vec<u8>>, RpcError>;
    /// `file` with its replica replaced by `snapshot` (KDM content), everything else as it was.
    fn replace(&self, file: &[u8], snapshot: &[u8]) -> Result<Vec<u8>, RpcError>;
}

fn damaged(error: impl std::fmt::Display) -> RpcError {
    RpcError::kit_detail(ErrorReason::UnsupportedFormat, format!("the file's replica is damaged: {error}"))
}

impl FileIdentity {
    /// The replica `file` embeds, loaded (and so checked: the kit, the KDM version, the id in both
    /// its places), or `None`.
    fn embedded(replica: &dyn EmbeddedReplica, file: &[u8]) -> Result<Option<Replica>, RpcError> {
        let Some(bytes) = replica.replica(file)? else { return Ok(None) };
        Replica::load(replica.schema(), &bytes, ActorId::random()).map(Some).map_err(damaged)
    }

    /// The document id `file` carries, or `None`.
    pub fn identity(&self, file: &[u8]) -> Result<Option<DocId>, RpcError> {
        match self {
            Self::NotEmbedded => Ok(None),
            Self::Embedded(replica) => Ok(Self::embedded(replica.as_ref(), file)?.map(|loaded| loaded.doc_id())),
        }
    }

    /// `file` as a new document: its replica replaced by a copy under a new id, which the answer
    /// gives; a file that carries no identity comes back unchanged, with `None`.
    pub fn fork(&self, file: &[u8]) -> Result<(Vec<u8>, Option<DocId>), RpcError> {
        let Self::Embedded(replica) = self else { return Ok((file.to_vec(), None)) };
        let Some(source) = Self::embedded(replica.as_ref(), file)? else { return Ok((file.to_vec(), None)) };
        let doc_id = DocId::new();
        let copy = source.copy_as_new_document(doc_id, ActorId::random()).map_err(|error| RpcError::internal(error.to_string()))?;
        let content = copy.content_snapshot().map_err(|error| RpcError::internal(error.to_string()))?;
        Ok((replica.replace(file, &content)?, Some(doc_id)))
    }
}

#[cfg(test)]
mod tests {
    use kition_kdm::Origin;
    use serde_json::Map;

    use super::*;

    const SCHEMA: &str = r#"{ "kdm": 1, "kit": "kit.test", "schemaVersion": 1, "root": "Page",
        "types": { "Page": { "fields": { "title": { "kind": "string" }, "notes": { "kind": "list", "of": "Note" } } },
                   "Note": { "fields": { "text": { "kind": "string" } } } } }"#;

    /// A container of a header line, then the replica after a zero byte.
    struct Container(Arc<Schema>);

    impl EmbeddedReplica for Container {
        fn schema(&self) -> Arc<Schema> {
            Arc::clone(&self.0)
        }
        fn replica(&self, file: &[u8]) -> Result<Option<Vec<u8>>, RpcError> {
            if !file.starts_with(b"TEST") {
                return Err(RpcError::kit(ErrorReason::UnsupportedFormat));
            }
            Ok(file.iter().position(|byte| *byte == 0).map(|at| file[at + 1..].to_vec()))
        }
        fn replace(&self, file: &[u8], snapshot: &[u8]) -> Result<Vec<u8>, RpcError> {
            let at = file.iter().position(|byte| *byte == 0).unwrap_or(file.len());
            Ok([&file[..at], &[0], snapshot].concat())
        }
    }

    fn container() -> FileIdentity {
        FileIdentity::Embedded(Arc::new(Container(Arc::new(Schema::parse(SCHEMA).unwrap_or_else(|error| panic!("{error}"))))))
    }

    fn file() -> (Vec<u8>, DocId) {
        let schema = Arc::new(Schema::parse(SCHEMA).unwrap_or_else(|error| panic!("{error}")));
        let mut replica = Replica::create(schema, DocId::new(), ActorId::random()).unwrap_or_else(|error| panic!("{error}"));
        let person = Origin::person("person:test");
        replica
            .transact(&person, |tx| {
                let mut fields = Map::new();
                fields.insert("title".into(), "Kept".into());
                let page = tx.create("Page", fields)?;
                let mut note = Map::new();
                note.insert("text".into(), "GONE-BEFORE-THE-FORK".into());
                let note = tx.create("Note", note)?;
                tx.list_insert(&page, "notes", 0, &note)?;
                tx.delete(&note)
            })
            .unwrap_or_else(|error| panic!("{error}"));
        let snapshot = replica.snapshot().unwrap_or_else(|error| panic!("{error}"));
        ([b"TEST header\0".as_slice(), &snapshot].concat(), replica.doc_id())
    }

    #[test]
    fn an_embedded_replica_tells_its_id_and_forks_into_a_new_document_without_history() {
        let (bytes, id) = file();
        let kind = container();
        assert_eq!(kind.identity(&bytes).unwrap_or_else(|error| panic!("{error}")), Some(id));
        let (forked, new) = kind.fork(&bytes).unwrap_or_else(|error| panic!("{error}"));
        let new = new.unwrap_or_else(|| panic!("a fork of an embedded replica has an id"));
        assert_ne!(new, id);
        assert!(forked.starts_with(b"TEST header\0"), "the rest of the container is kept");
        assert_eq!(kind.identity(&forked).unwrap_or_else(|error| panic!("{error}")), Some(new));
        let holds = |bytes: &[u8]| bytes.windows(20).any(|window| window == b"GONE-BEFORE-THE-FORK");
        assert!(!holds(&bytes) && !holds(&forked), "no deleted content in either");
        let (again, third) = kind.fork(&forked).unwrap_or_else(|error| panic!("{error}"));
        assert!(third.is_some_and(|third| third != new && third != id));
        assert!(kind.identity(&again).is_ok());
    }

    #[test]
    fn a_file_without_a_replica_has_no_id_and_forks_unchanged() {
        let plain = b"TEST no replica yet".to_vec();
        assert_eq!(container().identity(&plain).unwrap_or_else(|error| panic!("{error}")), None);
        assert_eq!(container().fork(&plain).unwrap_or_else(|error| panic!("{error}")), (plain.clone(), None));
        assert_eq!(FileIdentity::NotEmbedded.identity(&plain).unwrap_or_else(|error| panic!("{error}")), None);
        assert_eq!(FileIdentity::NotEmbedded.fork(&plain).unwrap_or_else(|error| panic!("{error}")), (plain, None));
    }

    #[test]
    fn a_damaged_replica_is_refused_never_read_as_none() {
        let damaged = b"TEST header\0not a replica".to_vec();
        for error in [container().identity(&damaged).unwrap_err(), container().fork(&damaged).map(|_| ()).unwrap_err()] {
            assert_eq!(error.reason(), Some(ErrorReason::UnsupportedFormat), "{error:?}");
        }
    }
}
