//! A reference to one binary frame carried beside a JSON message.

use serde::de::{Error as _, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// Stands in for a binary payload inside a message's `params` or `result`: `{"$bin": 0}` means
/// "the first binary frame that follows this message." [`crate::framing::Outgoing`] hands these
/// out when a message is built; [`crate::framing::Decoder`] hands back the frames a decoded
/// message's indices point into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Bin(pub u32);

impl Bin {
    /// The binary frame this index points to, or `None` if the decoded message carried fewer
    /// frames than it referenced.
    pub fn resolve(self, bins: &[Vec<u8>]) -> Option<&[u8]> {
        bins.get(self.0 as usize).map(Vec::as_slice)
    }
}

/// Resolves every index in `items`, in order; `None` if any index is out of range.
pub fn resolve_all<'a>(items: &[Bin], bins: &'a [Vec<u8>]) -> Option<Vec<&'a [u8]>> {
    items.iter().map(|bin| bin.resolve(bins)).collect()
}

impl Serialize for Bin {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry("$bin", &self.0)?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for Bin {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct BinVisitor;

        impl<'de> Visitor<'de> for BinVisitor {
            type Value = Bin;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(r#"an object {"$bin": <index>}"#)
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Bin, A::Error> {
                let mut index = None;
                while let Some(key) = map.next_key::<String>()? {
                    if key == "$bin" {
                        index = Some(map.next_value::<u32>()?);
                    } else {
                        map.next_value::<serde::de::IgnoredAny>()?;
                    }
                }
                index.map(Bin).ok_or_else(|| A::Error::missing_field("$bin"))
            }
        }

        deserializer.deserialize_map(BinVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let bin = Bin(3);
        let value = serde_json::to_value(bin).unwrap();
        assert_eq!(value, serde_json::json!({ "$bin": 3 }));
        assert_eq!(serde_json::from_value::<Bin>(value).unwrap(), bin);
    }

    #[test]
    fn rejects_an_object_with_no_bin_key() {
        assert!(serde_json::from_value::<Bin>(serde_json::json!({ "x": 1 })).is_err());
    }

    #[test]
    fn resolve_all_fails_closed_on_one_bad_index() {
        let bins = vec![b"a".to_vec(), b"b".to_vec()];
        assert_eq!(resolve_all(&[Bin(0), Bin(1)], &bins), Some(vec![b"a".as_slice(), b"b".as_slice()]));
        assert_eq!(resolve_all(&[Bin(0), Bin(5)], &bins), None);
    }
}
