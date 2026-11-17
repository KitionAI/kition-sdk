//! The wire framing: a JSON text frame carries a message whose `bins` field says how many
//! binary frames follow it, each one a payload one of the message's [`crate::Bin`] indices
//! points to. [`Outgoing`] builds the frames to send; [`Decoder`] turns an incoming stream of
//! frames back into complete messages, enforcing [`Limits`] a peer cannot exceed.

use crate::bin::Bin;
use serde_json::{Value, json};

/// One frame of the transport: a WebSocket text frame or a binary frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
}

/// Caps a decoder enforces so a broken or hostile peer cannot exhaust memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_json_bytes: usize,
    pub max_binary_bytes: usize,
    pub max_bins_per_message: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_json_bytes: 1024 * 1024, max_binary_bytes: 64 * 1024 * 1024, max_bins_per_message: 1024 }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum FramingError {
    #[error("the message is {size} bytes, more than the {limit}-byte limit")]
    JsonTooLarge { size: usize, limit: usize },
    #[error("a binary frame is {size} bytes, more than the {limit}-byte limit")]
    BinaryTooLarge { size: usize, limit: usize },
    #[error("the message declares {declared} binary frames, more than the {limit}-frame limit")]
    TooManyBins { declared: u64, limit: u32 },
    #[error("a binary frame arrived with no message awaiting one")]
    UnexpectedBinary,
    #[error("a text frame arrived before the previous message received all its binary frames")]
    MessageIncomplete,
    #[error("the message's `bins` field is not a non-negative integer")]
    InvalidBinsField,
    #[error("invalid json: {0}")]
    InvalidJson(String),
}

/// A complete decoded message: its JSON value (still carrying [`Bin`] indices in place of
/// bytes) and the binary frames those indices point into.
#[derive(Debug, Clone, PartialEq)]
pub struct Decoded {
    pub message: Value,
    pub bins: Vec<Vec<u8>>,
}

/// Collects the binary payloads a message under construction refers to, assigning each one a
/// [`Bin`] index as it is added. Build the message's JSON with those `Bin`s in place of the
/// bytes, then [`Outgoing::finish`] to get the frames to send, in order.
#[derive(Debug, Default)]
pub struct Outgoing {
    bins: Vec<Vec<u8>>,
}

impl Outgoing {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one binary payload and returns the index to put in its place in the message.
    pub fn bin(&mut self, data: impl Into<Vec<u8>>) -> Bin {
        let index = self.bins.len() as u32;
        self.bins.push(data.into());
        Bin(index)
    }

    /// The number of binary payloads registered so far.
    pub fn len(&self) -> u32 {
        self.bins.len() as u32
    }

    pub fn is_empty(&self) -> bool {
        self.bins.is_empty()
    }

    /// Sets `message`'s `bins` field and returns the frames to send: the text frame first, then
    /// each registered payload as a binary frame, in the order it was registered (and so in the
    /// order its `Bin` index points to it).
    pub fn finish(self, mut message: Value) -> Vec<Frame> {
        if let Value::Object(map) = &mut message {
            if self.bins.is_empty() {
                map.remove("bins");
            } else {
                map.insert("bins".to_owned(), json!(self.bins.len()));
            }
        }
        let mut frames = Vec::with_capacity(1 + self.bins.len());
        frames.push(Frame::Text(message.to_string()));
        frames.extend(self.bins.into_iter().map(Frame::Binary));
        frames
    }
}

/// Reassembles an incoming stream of [`Frame`]s into complete [`Decoded`] messages. Feed it one
/// frame at a time, in the order the transport delivers them.
pub struct Decoder {
    limits: Limits,
    pending: Option<Pending>,
}

struct Pending {
    message: Value,
    remaining: u32,
    bins: Vec<Vec<u8>>,
}

impl Decoder {
    pub fn new(limits: Limits) -> Self {
        Self { limits, pending: None }
    }

    /// Feeds one frame. Returns the completed message once every binary frame it declared has
    /// arrived, or `None` while more are still expected. Every malformed or over-limit frame is
    /// an `Err`, never a panic; a decoder that returns an error should not be fed further
    /// frames for the message in progress (the caller SHOULD close the connection).
    pub fn feed(&mut self, frame: Frame) -> Result<Option<Decoded>, FramingError> {
        match frame {
            Frame::Text(text) => self.feed_text(text),
            Frame::Binary(data) => self.feed_binary(data),
        }
    }

    fn feed_text(&mut self, text: String) -> Result<Option<Decoded>, FramingError> {
        if self.pending.is_some() {
            return Err(FramingError::MessageIncomplete);
        }
        if text.len() > self.limits.max_json_bytes {
            return Err(FramingError::JsonTooLarge { size: text.len(), limit: self.limits.max_json_bytes });
        }
        let message: Value = serde_json::from_str(&text).map_err(|error| FramingError::InvalidJson(error.to_string()))?;
        let declared = match message.get("bins") {
            None => 0,
            Some(value) => value.as_u64().ok_or(FramingError::InvalidBinsField)?,
        };
        if declared > u64::from(self.limits.max_bins_per_message) {
            return Err(FramingError::TooManyBins { declared, limit: self.limits.max_bins_per_message });
        }
        // `declared` fits `u32` once the limit check above passes (the limit itself is a `u32`).
        let declared = declared as u32;
        if declared == 0 {
            return Ok(Some(Decoded { message, bins: Vec::new() }));
        }
        self.pending = Some(Pending { message, remaining: declared, bins: Vec::with_capacity(declared as usize) });
        Ok(None)
    }

    fn feed_binary(&mut self, data: Vec<u8>) -> Result<Option<Decoded>, FramingError> {
        let Some(pending) = self.pending.as_mut() else {
            return Err(FramingError::UnexpectedBinary);
        };
        if data.len() > self.limits.max_binary_bytes {
            self.pending = None;
            return Err(FramingError::BinaryTooLarge { size: data.len(), limit: self.limits.max_binary_bytes });
        }
        pending.bins.push(data);
        pending.remaining -= 1;
        if pending.remaining > 0 {
            return Ok(None);
        }
        let Some(pending) = self.pending.take() else {
            return Ok(None);
        };
        Ok(Some(Decoded { message: pending.message, bins: pending.bins }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{self, RequestId};
    use serde_json::json;

    fn feed_all(decoder: &mut Decoder, frames: Vec<Frame>) -> Vec<Result<Option<Decoded>, FramingError>> {
        frames.into_iter().map(|frame| decoder.feed(frame)).collect()
    }

    #[test]
    fn round_trips_a_message_with_no_binaries() {
        let message = protocol::notification("room/leave", json!({ "docId": "d1" }));
        let frames = Outgoing::new().finish(message.clone());
        assert_eq!(frames, vec![Frame::Text(message.to_string())]);

        let mut decoder = Decoder::new(Limits::default());
        let decoded = decoder.feed(frames.into_iter().next().unwrap()).unwrap().unwrap();
        assert_eq!(decoded.message, message);
        assert!(decoded.bins.is_empty());
    }

    #[test]
    fn round_trips_a_message_with_several_binaries_in_order() {
        let mut out = Outgoing::new();
        let a = out.bin(b"first".to_vec());
        let b = out.bin(b"second".to_vec());
        let params = json!({ "docId": "d1", "changes": [a, b] });
        let message = protocol::request(RequestId::Number(1), "changes/push", params);
        let frames = out.finish(message);

        assert_eq!(frames.len(), 3);
        let mut decoder = Decoder::new(Limits::default());
        let mut iter = frames.into_iter();
        assert_eq!(decoder.feed(iter.next().unwrap()).unwrap(), None);
        assert_eq!(decoder.feed(iter.next().unwrap()).unwrap(), None);
        let decoded = decoder.feed(iter.next().unwrap()).unwrap().unwrap();
        assert_eq!(decoded.bins, vec![b"first".to_vec(), b"second".to_vec()]);
        assert_eq!(decoded.message["method"], "changes/push");
        assert_eq!(decoded.message["bins"], 2);
    }

    #[test]
    fn interleaves_two_independent_messages_back_to_back() {
        let mut first_out = Outgoing::new();
        let fb = first_out.bin(b"one".to_vec());
        let first = first_out.finish(protocol::notification("presence/set", json!({ "docId": "a", "state": fb })));

        let mut second_out = Outgoing::new();
        let sb1 = second_out.bin(b"two".to_vec());
        let sb2 = second_out.bin(b"three".to_vec());
        let second = second_out.finish(protocol::notification("presence/set", json!({ "docId": "b", "state": [sb1, sb2] })));

        let mut decoder = Decoder::new(Limits::default());
        let mut results = feed_all(&mut decoder, first.into_iter().chain(second).collect());

        // first: text (None), bin (Some) -- second: text (None), bin, bin (Some)
        let completed: Vec<_> = results.drain(..).filter_map(|r| r.unwrap()).collect();
        assert_eq!(completed.len(), 2);
        assert_eq!(completed[0].bins, vec![b"one".to_vec()]);
        assert_eq!(completed[0].message["params"]["docId"], "a");
        assert_eq!(completed[1].bins, vec![b"two".to_vec(), b"three".to_vec()]);
        assert_eq!(completed[1].message["params"]["docId"], "b");
    }

    #[test]
    fn rejects_an_oversized_text_frame_without_panicking() {
        let mut decoder = Decoder::new(Limits { max_json_bytes: 4, ..Limits::default() });
        assert_eq!(decoder.feed(Frame::Text("{\"too\":\"big\"}".into())), Err(FramingError::JsonTooLarge { size: 13, limit: 4 }));
    }

    #[test]
    fn rejects_an_oversized_binary_frame_and_recovers() {
        let mut decoder = Decoder::new(Limits { max_binary_bytes: 2, ..Limits::default() });
        let message = json!({ "jsonrpc": "2.0", "method": "blob/put", "bins": 1 });
        assert_eq!(decoder.feed(Frame::Text(message.to_string())), Ok(None));
        assert_eq!(decoder.feed(Frame::Binary(vec![1, 2, 3])), Err(FramingError::BinaryTooLarge { size: 3, limit: 2 }));
        // The decoder dropped the half-finished message; it accepts a fresh one.
        let next = json!({ "jsonrpc": "2.0", "method": "room/leave", "params": {} });
        assert_eq!(decoder.feed(Frame::Text(next.to_string())).unwrap().unwrap().message, next);
    }

    #[test]
    fn rejects_too_many_declared_bins() {
        let mut decoder = Decoder::new(Limits { max_bins_per_message: 2, ..Limits::default() });
        let message = json!({ "jsonrpc": "2.0", "method": "room/join", "bins": 3 });
        assert_eq!(decoder.feed(Frame::Text(message.to_string())), Err(FramingError::TooManyBins { declared: 3, limit: 2 }));
    }

    #[test]
    fn rejects_a_binary_frame_with_nothing_awaiting_it() {
        let mut decoder = Decoder::new(Limits::default());
        assert_eq!(decoder.feed(Frame::Binary(vec![1])), Err(FramingError::UnexpectedBinary));
    }

    #[test]
    fn rejects_a_text_frame_while_binaries_are_still_due() {
        let mut decoder = Decoder::new(Limits::default());
        let message = json!({ "jsonrpc": "2.0", "method": "blob/put", "bins": 1 });
        assert_eq!(decoder.feed(Frame::Text(message.to_string())), Ok(None));
        assert_eq!(decoder.feed(Frame::Text("{}".into())), Err(FramingError::MessageIncomplete));
    }

    #[test]
    fn rejects_malformed_json_and_a_non_numeric_bins_field() {
        let mut decoder = Decoder::new(Limits::default());
        assert!(matches!(decoder.feed(Frame::Text("not json".into())), Err(FramingError::InvalidJson(_))));
        let bad = json!({ "jsonrpc": "2.0", "method": "room/leave", "bins": "two" });
        assert_eq!(decoder.feed(Frame::Text(bad.to_string())), Err(FramingError::InvalidBinsField));
    }
}
