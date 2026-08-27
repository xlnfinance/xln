use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use super::RuntimeTransportError;
use super::crypto::{frame_digest, parse_public_hex, verify_peer_signature};
use super::msgpack::{decode_framed, encode_framed};

pub(super) type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

pub(super) fn verify_acknowledgement(
    value: &Value,
    target: &str,
    source: &str,
    audience: &str,
    challenge: &str,
) -> Result<u64, RuntimeTransportError> {
    if required_text(value, "type")? != "hello_ack"
        || required_text(value, "from")? != target
        || required_text(value, "to")? != source
    {
        return Err(RuntimeTransportError::Handshake("ack-route".into()));
    }
    parse_public_hex(&required_text(value, "fromEncryptionPubKey")?)?;
    parse_public_hex(&required_text(value, "sessionPubKey")?)?;
    let auth = value
        .get("auth")
        .and_then(Value::as_object)
        .ok_or_else(|| RuntimeTransportError::Handshake("ack-auth".into()))?;
    if auth.get("nonce").and_then(Value::as_str) != Some(challenge) {
        return Err(RuntimeTransportError::Handshake("ack-nonce".into()));
    }
    verify_ack_signature(value, auth, target, audience, challenge)
}

fn verify_ack_signature(
    value: &Value,
    auth: &Map<String, Value>,
    target: &str,
    audience: &str,
    challenge: &str,
) -> Result<u64, RuntimeTransportError> {
    let timestamp = auth
        .get("timestamp")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        .ok_or_else(|| RuntimeTransportError::Handshake("ack-timestamp".into()))?;
    let signature = auth
        .get("signature")
        .and_then(Value::as_str)
        .ok_or_else(|| RuntimeTransportError::Handshake("ack-signature".into()))?;
    let mut unsigned = value
        .as_object()
        .cloned()
        .ok_or_else(|| RuntimeTransportError::Handshake("ack-object".into()))?;
    unsigned.remove("auth");
    unsigned.remove("v");
    let digest = frame_digest(&Value::Object(unsigned), audience, challenge, timestamp)?;
    verify_peer_signature(target, &digest, signature)?;
    Ok(timestamp)
}

pub(super) fn send_value<S: Read + Write>(
    socket: &mut WebSocket<S>,
    value: &Value,
    max_message_bytes: usize,
) -> Result<(), RuntimeTransportError> {
    let mut envelope = value
        .as_object()
        .cloned()
        .ok_or_else(|| RuntimeTransportError::MessagePack("ws-object".into()))?;
    envelope.insert("v".into(), Value::from(1));
    let bytes = encode_framed(&Value::Object(envelope))?;
    if bytes.len() > max_message_bytes {
        return Err(RuntimeTransportError::MessageBytes(bytes.len()));
    }
    socket
        .send(Message::Binary(bytes.into()))
        .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))
}

pub(super) fn read_value<S: Read + Write>(
    socket: &mut WebSocket<S>,
) -> Result<Value, RuntimeTransportError> {
    loop {
        match socket
            .read()
            .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?
        {
            Message::Binary(bytes) => return decode_framed(&bytes),
            Message::Ping(bytes) => socket
                .send(Message::Pong(bytes))
                .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?,
            Message::Close(frame) => {
                return Err(RuntimeTransportError::Handshake(format!(
                    "closed:{frame:?}"
                )));
            }
            Message::Text(_) => return Err(RuntimeTransportError::Handshake("text-wire".into())),
            _ => {}
        }
    }
}

pub(super) fn try_read_value<S: Read + Write>(
    socket: &mut WebSocket<S>,
) -> Result<Option<Value>, RuntimeTransportError> {
    loop {
        match socket.read() {
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                return Ok(None);
            }
            Err(error) => return Err(RuntimeTransportError::WebSocket(error.to_string())),
            Ok(Message::Binary(bytes)) => return decode_framed(&bytes).map(Some),
            Ok(Message::Ping(bytes)) => socket
                .send(Message::Pong(bytes))
                .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?,
            Ok(Message::Close(frame)) => {
                return Err(RuntimeTransportError::Handshake(format!(
                    "closed:{frame:?}"
                )));
            }
            Ok(Message::Text(_)) => {
                return Err(RuntimeTransportError::Handshake("text-wire".into()));
            }
            Ok(_) => {}
        }
    }
}

pub(super) fn set_timeouts(
    socket: &mut Socket,
    timeout: Duration,
) -> Result<(), RuntimeTransportError> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => set_stream_timeout(stream, timeout),
        MaybeTlsStream::Rustls(stream) => set_stream_timeout(stream.get_mut(), timeout),
        _ => Ok(()),
    }
}

fn set_stream_timeout(stream: &TcpStream, timeout: Duration) -> Result<(), RuntimeTransportError> {
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|()| stream.set_write_timeout(Some(timeout)))
        .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))
}

pub(super) fn required_text(value: &Value, field: &str) -> Result<String, RuntimeTransportError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RuntimeTransportError::Handshake(field.into()))
}

pub(super) fn object<'a>(fields: impl IntoIterator<Item = (&'a str, Value)>) -> Value {
    Value::Object(Map::from_iter(
        fields.into_iter().map(|(key, value)| (key.into(), value)),
    ))
}

pub(super) fn typed_array(bytes: Vec<u8>) -> Value {
    Value::Object(Map::from_iter([
        ("__xlnType".into(), Value::String("TypedArray".into())),
        ("kind".into(), Value::String("Uint8Array".into())),
        ("value".into(), Value::String(BASE64.encode(bytes))),
    ]))
}

pub(super) fn unix_ms() -> Result<u64, RuntimeTransportError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| RuntimeTransportError::Crypto("wall-clock"))?
        .as_millis();
    u64::try_from(millis)
        .ok()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or(RuntimeTransportError::Crypto("wall-clock-range"))
}
