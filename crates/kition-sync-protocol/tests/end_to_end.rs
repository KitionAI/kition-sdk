//! A full message round trip through the typed params/results, the JSON-RPC envelope, and the
//! binary framing together: what a client and server actually exchange on the wire.

use kition_sync_protocol::bin::resolve_all;
use kition_sync_protocol::framing::{Decoder, Frame, Limits, Outgoing};
use kition_sync_protocol::messages::{ChangesPushParams, ChangesPushResult, Presence, Role, RoomJoinParams, RoomJoinResult, method};
use kition_sync_protocol::protocol::{self, Message, RequestId};
use serde_json::json;

#[test]
fn a_client_joins_a_room_and_pushes_a_change() {
    // The client builds `room/join`, asking to catch up from seq 5 (no binary frames: `since` is
    // a plain number, never a KDM version the server would need a replica to compare against).
    let out = Outgoing::new();
    let params = serde_json::to_value(RoomJoinParams { doc_id: "doc1".into(), since: Some(5), limit: None, shallow: false, prefer: None }).unwrap();
    let request = protocol::request(RequestId::Number(1), method::ROOM_JOIN, params);
    let frames = out.finish(request);
    assert_eq!(frames.len(), 1);

    // The "server" decodes the frames back into the request.
    let mut decoder = Decoder::new(Limits::default());
    let mut decoded = None;
    for frame in frames {
        if let Some(d) = decoder.feed(frame).unwrap() {
            decoded = Some(d);
        }
    }
    let decoded = decoded.unwrap();
    let Message::Request { id, method, params } = protocol::parse(decoded.message).unwrap() else {
        panic!("expected a request");
    };
    assert_eq!(method, "room/join");
    let join_params: RoomJoinParams = protocol::params(params).unwrap();
    assert_eq!(join_params.since, Some(5));

    // The server answers with two changes after seq 5, and the room's latest seq.
    let mut out = Outgoing::new();
    let c0 = out.bin(b"change-0".to_vec());
    let c1 = out.bin(b"change-1".to_vec());
    let result = RoomJoinResult {
        changes: vec![c0, c1],
        seq: 7,
        more: false,
        presence: vec![Presence { principal_id: "p2".into(), name: "Bo".into(), color: "#00f".into(), state: json!({}) }],
        role: Role::Editor,
        snapshot: false,
        shallow: false,
    };
    let frames = out.finish(protocol::result_response(&id, serde_json::to_value(&result).unwrap()));

    let mut decoder = Decoder::new(Limits::default());
    let mut decoded = None;
    for frame in frames {
        if let Some(d) = decoder.feed(frame).unwrap() {
            decoded = Some(d);
        }
    }
    let decoded = decoded.unwrap();
    let Message::Response { outcome: Ok(result_value), .. } = protocol::parse(decoded.message).unwrap() else {
        panic!("expected a successful response");
    };
    let result: RoomJoinResult = serde_json::from_value(result_value).unwrap();
    let changes = resolve_all(&result.changes, &decoded.bins).unwrap();
    assert_eq!(changes, vec![b"change-0".as_slice(), b"change-1".as_slice()]);
    assert_eq!(result.role, Role::Editor);
    assert_eq!(result.seq, 7);

    // The client pushes one change of its own.
    let mut out = Outgoing::new();
    let change = out.bin(b"client-change".to_vec());
    let push_params = serde_json::to_value(ChangesPushParams { doc_id: "doc1".into(), changes: change }).unwrap();
    let frames = out.finish(protocol::request(RequestId::Number(2), method::CHANGES_PUSH, push_params));
    assert_eq!(frames.len(), 2);

    let mut decoder = Decoder::new(Limits::default());
    let mut decoded = None;
    for frame in frames {
        if let Some(d) = decoder.feed(frame).unwrap() {
            decoded = Some(d);
        }
    }
    let decoded = decoded.unwrap();
    let Message::Request { params, .. } = protocol::parse(decoded.message).unwrap() else {
        panic!("expected a request");
    };
    let push: ChangesPushParams = protocol::params(params).unwrap();
    assert_eq!(push.changes.resolve(&decoded.bins), Some(b"client-change".as_slice()));

    let ack = protocol::result_response(&RequestId::Number(2), serde_json::to_value(ChangesPushResult { seq: 1 }).unwrap());
    assert_eq!(ack["result"]["seq"], 1);
}

#[test]
fn a_malformed_frame_stream_never_panics() {
    let mut decoder = Decoder::new(Limits { max_bins_per_message: 1, ..Limits::default() });
    // Declares more bins than the limit allows.
    let oversized = json!({ "jsonrpc": "2.0", "method": method::CHANGES_PULL, "params": {}, "bins": 5 });
    assert!(decoder.feed(Frame::Text(oversized.to_string())).is_err());
    // The decoder is still usable for the next, well-formed message.
    let ok = json!({ "jsonrpc": "2.0", "method": method::ROOM_LEAVE, "params": { "docId": "d1" } });
    assert!(decoder.feed(Frame::Text(ok.to_string())).unwrap().is_some());
}
