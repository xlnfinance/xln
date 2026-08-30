//! Minimal native operator surface for the zero-JS Runtime process.
//!
//! The HTTP thread never owns Runtime state. The single writer publishes one
//! immutable JSON snapshot after a real state transition; readers clone that
//! snapshot. Unknown product endpoints fail closed instead of fabricating TS
//! bootstrap state.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{Value, json};
use xln_rscore_batch::AccountId;
use xln_rscore_engine::TokenId;
use xln_rscore_runtime::RuntimeEntityInput;

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_COMMAND_ENTITY_INPUTS: usize = 10_000;

pub enum RuntimeHttpCommand {
    ApplyEntityInputs {
        command_id: String,
        entity_inputs: Vec<RuntimeEntityInput>,
        committed: SyncSender<Result<u64, String>>,
    },
    AccountStatus {
        hub_entity_id: [u8; 32],
        hub_entity_id_text: String,
        counterparty: AccountId,
        counterparty_text: String,
        token_ids: Vec<TokenId>,
        response: SyncSender<Result<Value, String>>,
    },
    EntityProfile {
        entity_id: [u8; 32],
        entity_id_text: String,
        response: SyncSender<Result<Option<Value>, String>>,
    },
    MarketCatalog {
        hub_entity_id: [u8; 32],
        hub_entity_id_text: String,
        response: SyncSender<Result<Value, String>>,
    },
    MarketSnapshots {
        hub_entity_id: [u8; 32],
        hub_entity_id_text: String,
        pair_ids: Vec<String>,
        depth: usize,
        response: SyncSender<Result<Value, String>>,
    },
    Tokens {
        response: SyncSender<Result<Value, String>>,
    },
    FaucetOffchain {
        request: NativeOffchainFaucetRequest,
        response: SyncSender<Result<(u16, Value), String>>,
    },
}

pub struct NativeOffchainFaucetRequest {
    pub hub_entity_id: [u8; 32],
    pub hub_entity_id_text: String,
    pub user_entity_id: AccountId,
    pub user_entity_id_text: String,
    pub user_runtime_id: String,
    pub token_id: TokenId,
    pub amount: String,
}

pub fn runtime_http_command_channel()
-> (SyncSender<RuntimeHttpCommand>, Receiver<RuntimeHttpCommand>) {
    sync_channel(64)
}

#[derive(Clone)]
pub struct RuntimeHttpState {
    snapshot: Arc<Mutex<Value>>,
    quiescing: Arc<AtomicBool>,
    commands: Option<SyncSender<RuntimeHttpCommand>>,
}

impl RuntimeHttpState {
    pub fn new(initial: Value) -> Result<Self, String> {
        validate_snapshot(&initial)?;
        Ok(Self {
            snapshot: Arc::new(Mutex::new(initial)),
            quiescing: Arc::new(AtomicBool::new(false)),
            commands: None,
        })
    }

    pub fn with_commands(
        initial: Value,
        commands: SyncSender<RuntimeHttpCommand>,
    ) -> Result<Self, String> {
        let mut state = Self::new(initial)?;
        state.commands = Some(commands);
        Ok(state)
    }

    pub fn publish(&self, snapshot: Value) -> Result<(), String> {
        validate_snapshot(&snapshot)?;
        *self
            .snapshot
            .lock()
            .map_err(|_| "RRS_RUNTIME_HTTP_SNAPSHOT_LOCK".to_string())? = snapshot;
        Ok(())
    }

    pub fn quiescing(&self) -> bool {
        self.quiescing.load(Ordering::Acquire)
    }
}

pub struct RuntimeHttpServer {
    local_address: SocketAddr,
    state: RuntimeHttpState,
    thread: Option<JoinHandle<()>>,
}

impl RuntimeHttpServer {
    pub fn bind(address: SocketAddr, state: RuntimeHttpState) -> Result<Self, String> {
        let listener =
            TcpListener::bind(address).map_err(|error| format!("RRS_RUNTIME_HTTP_BIND:{error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("RRS_RUNTIME_HTTP_NONBLOCKING:{error}"))?;
        let local_address = listener
            .local_addr()
            .map_err(|error| format!("RRS_RUNTIME_HTTP_ADDRESS:{error}"))?;
        let thread_state = state.clone();
        let thread = thread::Builder::new()
            .name("rrs-runtime-http".into())
            .spawn(move || run(listener, thread_state))
            .map_err(|error| format!("RRS_RUNTIME_HTTP_THREAD:{error}"))?;
        Ok(Self {
            local_address,
            state,
            thread: Some(thread),
        })
    }

    pub fn local_address(&self) -> SocketAddr {
        self.local_address
    }

    pub fn state(&self) -> RuntimeHttpState {
        self.state.clone()
    }
}

impl Drop for RuntimeHttpServer {
    fn drop(&mut self) {
        self.state.quiescing.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn validate_snapshot(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "RRS_RUNTIME_HTTP_SNAPSHOT_OBJECT".to_string())?;
    if object.len() != 3
        || !object.contains_key("info")
        || !object.contains_key("health")
        || !object.contains_key("metrics")
    {
        return Err("RRS_RUNTIME_HTTP_SNAPSHOT_FIELDS".into());
    }
    if !object["info"].is_object()
        || !object["health"].is_object()
        || !object["metrics"].is_object()
    {
        return Err("RRS_RUNTIME_HTTP_SNAPSHOT_VALUES".into());
    }
    Ok(())
}

fn run(listener: TcpListener, state: RuntimeHttpState) {
    while !state.quiescing() {
        match listener.accept() {
            Ok((mut stream, _)) => {
                if let Err(error) = serve(&mut stream, &state) {
                    let _ = response(
                        &mut stream,
                        500,
                        &json!({"error": error, "code": "RRS_RUNTIME_HTTP_FAILED"}),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(_) => {
                state.quiescing.store(true, Ordering::Release);
            }
        }
    }
}

fn serve(stream: &mut TcpStream, state: &RuntimeHttpState) -> Result<(), String> {
    // macOS may inherit O_NONBLOCK from the listener onto accepted sockets.
    // The server handles each bounded request synchronously; leaving that bit
    // set turns a normal split TCP header into EAGAIN and a false HTTP 500.
    stream
        .set_nonblocking(false)
        .map_err(|error| format!("RRS_RUNTIME_HTTP_BLOCKING:{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| format!("RRS_RUNTIME_HTTP_TIMEOUT:{error}"))?;
    let bytes = read_request(stream)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "RRS_RUNTIME_HTTP_UTF8".to_string())?;
    let request_line = text
        .split("\r\n")
        .next()
        .ok_or_else(|| "RRS_RUNTIME_HTTP_REQUEST_LINE".to_string())?;
    let parts = request_line.split(' ').collect::<Vec<_>>();
    let [method, target, version] = parts.as_slice() else {
        return Err("RRS_RUNTIME_HTTP_REQUEST_LINE".into());
    };
    if *version != "HTTP/1.1" && *version != "HTTP/1.0" {
        return Err("RRS_RUNTIME_HTTP_VERSION".into());
    }
    let path = target.split('?').next().unwrap_or(target);
    match (*method, path) {
        ("GET", "/api/info") | ("GET", "/api/health") | ("GET", "/api/metrics") => {
            let snapshot = state
                .snapshot
                .lock()
                .map_err(|_| "RRS_RUNTIME_HTTP_SNAPSHOT_LOCK".to_string())?;
            let field = match path {
                "/api/info" => "info",
                "/api/health" => "health",
                _ => "metrics",
            };
            response(stream, 200, &snapshot[field])
        }
        ("POST", "/api/control/runtime/entity-inputs") => {
            let commands = state
                .commands
                .as_ref()
                .ok_or_else(|| "RRS_RUNTIME_HTTP_COMMANDS_UNAVAILABLE".to_string())?;
            let body = request_body(&bytes)?;
            let value: Value = serde_json::from_slice(body)
                .map_err(|error| format!("RRS_RUNTIME_HTTP_COMMAND_JSON:{error}"))?;
            let command = decode_command(&value)?;
            let command_id = command.command_id.clone();
            let (committed, result) = sync_channel(1);
            commands
                .send(RuntimeHttpCommand::ApplyEntityInputs {
                    command_id: command.command_id,
                    entity_inputs: command.entity_inputs,
                    committed,
                })
                .map_err(|_| "RRS_RUNTIME_HTTP_COMMAND_SEND".to_string())?;
            match result.recv_timeout(Duration::from_secs(20)) {
                Ok(Ok(height)) => response(
                    stream,
                    200,
                    &json!({"ok":true,"commandId":command_id,"height":height}),
                ),
                Ok(Err(error)) => response(
                    stream,
                    503,
                    &json!({"ok":false,"commandId":command_id,"error":error}),
                ),
                Err(_) => response(
                    stream,
                    503,
                    &json!({"ok":false,"commandId":command_id,"error":"commit timeout"}),
                ),
            }
        }
        ("GET", "/api/account/status") => {
            let commands = state
                .commands
                .as_ref()
                .ok_or_else(|| "RRS_RUNTIME_HTTP_COMMANDS_UNAVAILABLE".to_string())?;
            let query = target.split_once('?').map_or("", |(_, query)| query);
            let parameters = form_urlencoded::parse(query.as_bytes()).collect::<Vec<_>>();
            let parameter = |name: &str| {
                parameters
                    .iter()
                    .find_map(|(key, value)| (key == name).then_some(value.as_ref()))
            };
            let hub_text = parameter("hubEntityId")
                .ok_or_else(|| "RRS_RUNTIME_HTTP_ACCOUNT_HUB".to_string())?;
            let counterparty_text = parameter("counterpartyEntityId")
                .ok_or_else(|| "RRS_RUNTIME_HTTP_ACCOUNT_COUNTERPARTY".to_string())?;
            let hub_entity_id =
                parse_hex32(hub_text).ok_or_else(|| "RRS_RUNTIME_HTTP_ACCOUNT_HUB".to_string())?;
            let counterparty_bytes = parse_hex32(counterparty_text)
                .ok_or_else(|| "RRS_RUNTIME_HTTP_ACCOUNT_COUNTERPARTY".to_string())?;
            let token_ids = parameter("tokenIds")
                .unwrap_or("")
                .split(',')
                .filter(|value| !value.is_empty())
                .map(|value| {
                    value
                        .parse::<u32>()
                        .ok()
                        .and_then(|value| TokenId::new(value).ok())
                        .ok_or_else(|| "RRS_RUNTIME_HTTP_ACCOUNT_TOKEN".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            if token_ids.len() > 128 {
                return response(
                    stream,
                    400,
                    &json!({"success":false,"code":"ACCOUNT_STATUS_BAD_REQUEST","error":"too many tokenIds"}),
                );
            }
            let (reply, result) = sync_channel(1);
            commands
                .send(RuntimeHttpCommand::AccountStatus {
                    hub_entity_id,
                    hub_entity_id_text: hub_text.to_string(),
                    counterparty: AccountId::from_bytes(counterparty_bytes),
                    counterparty_text: counterparty_text.to_string(),
                    token_ids,
                    response: reply,
                })
                .map_err(|_| "RRS_RUNTIME_HTTP_COMMAND_SEND".to_string())?;
            match result.recv_timeout(Duration::from_secs(2)) {
                Ok(Ok(value)) => response(stream, 200, &value),
                Ok(Err(error)) => response(
                    stream,
                    503,
                    &json!({
                        "success":false,"code":"RRS_RUNTIME_ACCOUNT_STATUS_FAILED","error":error
                    }),
                ),
                Err(_) => response(
                    stream,
                    503,
                    &json!({
                        "success":false,"code":"RRS_RUNTIME_ACCOUNT_STATUS_TIMEOUT","error":"query timeout"
                    }),
                ),
            }
        }
        ("GET", "/api/gossip/profile") => {
            let entity_id_text = target
                .split_once('?')
                .and_then(|(_, query)| {
                    query
                        .split('&')
                        .find_map(|pair| pair.strip_prefix("entityId="))
                })
                .filter(|value| {
                    value.len() == 66
                        && value.starts_with("0x")
                        && value[2..]
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
                .ok_or_else(|| "RRS_RUNTIME_HTTP_PROFILE_ENTITY_ID".to_string())?;
            let entity_id = parse_hex32(entity_id_text)
                .ok_or_else(|| "RRS_RUNTIME_HTTP_PROFILE_ENTITY_ID".to_string())?;
            let commands = state
                .commands
                .as_ref()
                .ok_or_else(|| "RRS_RUNTIME_HTTP_COMMANDS_UNAVAILABLE".to_string())?;
            let (reply, result) = sync_channel(1);
            commands
                .send(RuntimeHttpCommand::EntityProfile {
                    entity_id,
                    entity_id_text: entity_id_text.to_string(),
                    response: reply,
                })
                .map_err(|_| "RRS_RUNTIME_HTTP_COMMAND_SEND".to_string())?;
            match result.recv_timeout(Duration::from_secs(2)) {
                Ok(Ok(profile)) => response(
                    stream,
                    200,
                    &json!({
                        "ok": true,
                        "entityId": entity_id_text,
                        "found": profile.is_some(),
                        "profile": profile,
                        "peers": [],
                    }),
                ),
                Ok(Err(error)) => response(
                    stream,
                    503,
                    &json!({"ok":false,"entityId":entity_id_text,"error":error}),
                ),
                Err(_) => response(
                    stream,
                    503,
                    &json!({"ok":false,"entityId":entity_id_text,"error":"query timeout"}),
                ),
            }
        }
        ("POST", "/api/control/core/quiesce") => {
            state.quiescing.store(true, Ordering::Release);
            response(stream, 200, &json!({"ok": true, "quiescing": true}))
        }
        ("GET", "/api/market/catalog") => {
            let (hub_entity_id, hub_entity_id_text) = market_hub(target, state)?;
            let commands = state
                .commands
                .as_ref()
                .ok_or_else(|| "RRS_RUNTIME_HTTP_COMMANDS_UNAVAILABLE".to_string())?;
            let (reply, result) = sync_channel(1);
            commands
                .send(RuntimeHttpCommand::MarketCatalog {
                    hub_entity_id,
                    hub_entity_id_text,
                    response: reply,
                })
                .map_err(|_| "RRS_RUNTIME_HTTP_COMMAND_SEND".to_string())?;
            command_response(stream, result)
        }
        ("GET", "/api/market/snapshots") => {
            let (hub_entity_id, hub_entity_id_text) = market_hub(target, state)?;
            let query = target.split_once('?').map_or("", |(_, query)| query);
            let parameters = form_urlencoded::parse(query.as_bytes()).collect::<Vec<_>>();
            let mut pair_ids = Vec::new();
            for (_, value) in parameters
                .iter()
                .filter(|(key, _)| key == "pair" || key == "pairId")
            {
                let pair_id = normalize_market_pair(value)
                    .ok_or_else(|| "RRS_RUNTIME_HTTP_MARKET_PAIR".to_string())?;
                if !pair_ids.contains(&pair_id) {
                    pair_ids.push(pair_id);
                }
            }
            if pair_ids.is_empty() || pair_ids.len() > 100 {
                return response(
                    stream,
                    400,
                    &json!({"error":"Missing valid pair query parameters"}),
                );
            }
            let depth = parameters
                .iter()
                .find_map(|(key, value)| (key == "depth").then_some(value.as_ref()))
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(20)
                .clamp(1, 100);
            let commands = state
                .commands
                .as_ref()
                .ok_or_else(|| "RRS_RUNTIME_HTTP_COMMANDS_UNAVAILABLE".to_string())?;
            let (reply, result) = sync_channel(1);
            commands
                .send(RuntimeHttpCommand::MarketSnapshots {
                    hub_entity_id,
                    hub_entity_id_text,
                    pair_ids,
                    depth,
                    response: reply,
                })
                .map_err(|_| "RRS_RUNTIME_HTTP_COMMAND_SEND".to_string())?;
            command_response(stream, result)
        }
        ("GET", "/api/tokens") => {
            let commands = state
                .commands
                .as_ref()
                .ok_or_else(|| "RRS_RUNTIME_HTTP_COMMANDS_UNAVAILABLE".to_string())?;
            let (reply, result) = sync_channel(1);
            commands
                .send(RuntimeHttpCommand::Tokens { response: reply })
                .map_err(|_| "RRS_RUNTIME_HTTP_COMMAND_SEND".to_string())?;
            command_response(stream, result)
        }
        ("POST", "/api/faucet/offchain") => {
            let body = request_body(&bytes)?;
            let value: Value = serde_json::from_slice(body)
                .map_err(|error| format!("RRS_RUNTIME_HTTP_FAUCET_JSON:{error}"))?;
            let object = value
                .as_object()
                .ok_or_else(|| "RRS_RUNTIME_HTTP_FAUCET_BODY_OBJECT_REQUIRED".to_string())?;
            let Some(user_entity_id_text) = object.get("userEntityId").and_then(Value::as_str)
            else {
                return response(
                    stream,
                    400,
                    &json!({"code":"FAUCET_USER_ENTITY_ID_REQUIRED","error":"Missing userEntityId"}),
                );
            };
            let Some(user_entity_id) = parse_hex32(&user_entity_id_text.to_ascii_lowercase())
            else {
                return response(
                    stream,
                    400,
                    &json!({
                        "code":"FAUCET_INVALID_USER_ENTITY_ID",
                        "error":format!("Invalid userEntityId: expected bytes32 hex, got \"{user_entity_id_text}\"")
                    }),
                );
            };
            let hub_entity_id_text = object
                .get("hubEntityId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let Some(hub_entity_id) = parse_hex32(&hub_entity_id_text) else {
                return response(
                    stream,
                    400,
                    &json!({
                        "code":"FAUCET_INVALID_HUB_ENTITY_ID",
                        "error":format!("Invalid hubEntityId: expected bytes32 hex, got \"{hub_entity_id_text}\"")
                    }),
                );
            };
            let token_id_raw = object.get("tokenId").and_then(Value::as_u64).unwrap_or(1);
            let token_id = u32::try_from(token_id_raw)
                .ok()
                .and_then(|value| TokenId::new(value).ok());
            let Some(token_id) = token_id else {
                return response(
                    stream,
                    400,
                    &json!({"code":"FAUCET_INVALID_TOKEN_ID","error":"Invalid tokenId: expected positive safe integer"}),
                );
            };
            let user_runtime_id = object
                .get("userRuntimeId")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .filter(|value| parse_hex20(value).is_some());
            let Some(user_runtime_id) = user_runtime_id else {
                return response(
                    stream,
                    400,
                    &json!({
                        "success":false,
                        "code":"FAUCET_RUNTIME_REQUIRED",
                        "error":"Missing userRuntimeId"
                    }),
                );
            };
            let amount = object
                .get("amount")
                .and_then(Value::as_str)
                .unwrap_or("100")
                .to_string();
            let commands = state
                .commands
                .as_ref()
                .ok_or_else(|| "RRS_RUNTIME_HTTP_COMMANDS_UNAVAILABLE".to_string())?;
            let (reply, result) = sync_channel(1);
            commands
                .send(RuntimeHttpCommand::FaucetOffchain {
                    request: NativeOffchainFaucetRequest {
                        hub_entity_id,
                        hub_entity_id_text,
                        user_entity_id: AccountId::from_bytes(user_entity_id),
                        user_entity_id_text: user_entity_id_text.to_ascii_lowercase(),
                        user_runtime_id,
                        token_id,
                        amount,
                    },
                    response: reply,
                })
                .map_err(|_| "RRS_RUNTIME_HTTP_COMMAND_SEND".to_string())?;
            match result.recv_timeout(Duration::from_secs(4)) {
                Ok(Ok((status, body))) => response(stream, status, &body),
                Ok(Err(error)) => response(
                    stream,
                    500,
                    &json!({"code":"FAUCET_UNHANDLED_ERROR","error":error}),
                ),
                Err(_) => response(
                    stream,
                    503,
                    &json!({"code":"FAUCET_RUNTIME_UNAVAILABLE","error":"query timeout"}),
                ),
            }
        }
        _ => response(
            stream,
            404,
            &json!({"error": "not found", "code": "RRS_RUNTIME_HTTP_NOT_FOUND"}),
        ),
    }
}

fn command_response(
    stream: &mut TcpStream,
    result: Receiver<Result<Value, String>>,
) -> Result<(), String> {
    match result.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(value)) => response(stream, 200, &value),
        Ok(Err(error)) => response(stream, 503, &json!({"error":error})),
        Err(_) => response(stream, 503, &json!({"error":"query timeout"})),
    }
}

fn market_hub(target: &str, state: &RuntimeHttpState) -> Result<([u8; 32], String), String> {
    let query = target.split_once('?').map_or("", |(_, query)| query);
    let requested = form_urlencoded::parse(query.as_bytes()).find_map(|(key, value)| {
        (key == "hubEntityId" || key == "hub").then_some(value.into_owned())
    });
    let hub_entity_id_text = match requested {
        Some(value) => value.trim().to_ascii_lowercase(),
        None => state
            .snapshot
            .lock()
            .map_err(|_| "RRS_RUNTIME_HTTP_SNAPSHOT_LOCK".to_string())?
            .get("info")
            .and_then(|value| value.get("entityId"))
            .and_then(Value::as_str)
            .ok_or_else(|| "RRS_RUNTIME_HTTP_MARKET_HUB".to_string())?
            .to_string(),
    };
    let hub_entity_id = parse_hex32(&hub_entity_id_text)
        .ok_or_else(|| "RRS_RUNTIME_HTTP_MARKET_HUB".to_string())?;
    Ok((hub_entity_id, hub_entity_id_text))
}

fn normalize_market_pair(value: &str) -> Option<String> {
    let value = value.trim();
    let (left, right) = value.split_once('/')?;
    if let (Ok(left), Ok(right)) = (left.parse::<u64>(), right.parse::<u64>()) {
        return (left > 0 && right > 0 && left != right)
            .then(|| format!("{}/{}", left.min(right), left.max(right)));
    }
    let left = left.strip_prefix("cross:")?.to_ascii_lowercase();
    let right = right.to_ascii_lowercase();
    let valid = |part: &str| {
        let (prefix, token) = part.rsplit_once(':').unwrap_or(("", ""));
        !prefix.is_empty()
            && token.parse::<u64>().is_ok_and(|token| token > 0)
            && prefix.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b":._-".contains(&byte)
            })
    };
    (value.len() <= 256 && left != right && valid(&left) && valid(&right))
        .then(|| format!("cross:{left}/{right}"))
}

fn read_request(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("RRS_RUNTIME_HTTP_READ:{error}"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err("RRS_RUNTIME_HTTP_REQUEST_SIZE".into());
        }
        let Some(header_end) = find_header_end(&bytes) else {
            continue;
        };
        let content_length = content_length(&bytes[..header_end])?;
        if bytes.len() >= header_end + 4 + content_length {
            bytes.truncate(header_end + 4 + content_length);
            return Ok(bytes);
        }
    }
    if bytes.is_empty() || find_header_end(&bytes).is_none() {
        return Err("RRS_RUNTIME_HTTP_REQUEST_SIZE".into());
    }
    Ok(bytes)
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(headers: &[u8]) -> Result<usize, String> {
    let headers =
        std::str::from_utf8(headers).map_err(|_| "RRS_RUNTIME_HTTP_HEADERS_UTF8".to_string())?;
    for line in headers.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            return Err("RRS_RUNTIME_HTTP_HEADER".into());
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            return value
                .trim()
                .parse::<usize>()
                .ok()
                .filter(|value| *value <= MAX_REQUEST_BYTES)
                .ok_or_else(|| "RRS_RUNTIME_HTTP_CONTENT_LENGTH".to_string());
        }
    }
    Ok(0)
}

fn request_body(bytes: &[u8]) -> Result<&[u8], String> {
    let header_end =
        find_header_end(bytes).ok_or_else(|| "RRS_RUNTIME_HTTP_REQUEST_HEADERS".to_string())?;
    Ok(&bytes[header_end + 4..])
}

struct DecodedCommand {
    command_id: String,
    entity_inputs: Vec<RuntimeEntityInput>,
}

fn decode_command(value: &Value) -> Result<DecodedCommand, String> {
    let object = value
        .as_object()
        .filter(|object| {
            object.len() == 2
                && object.contains_key("commandId")
                && object.contains_key("entityInputs")
        })
        .ok_or_else(|| "RRS_RUNTIME_HTTP_COMMAND_FIELDS".to_string())?;
    let command_id = object["commandId"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| "RRS_RUNTIME_HTTP_COMMAND_ID".to_string())?
        .to_owned();
    let rows = object["entityInputs"]
        .as_array()
        .filter(|rows| !rows.is_empty() && rows.len() <= MAX_COMMAND_ENTITY_INPUTS)
        .ok_or_else(|| "RRS_RUNTIME_HTTP_COMMAND_INPUTS".to_string())?;
    let entity_inputs = rows
        .iter()
        .cloned()
        .map(RuntimeEntityInput::decode)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("RRS_RUNTIME_HTTP_COMMAND_DECODE:{error}"))?;
    Ok(DecodedCommand {
        command_id,
        entity_inputs,
    })
}

fn response(stream: &mut TcpStream, status: u16, body: &Value) -> Result<(), String> {
    let body =
        serde_json::to_vec(body).map_err(|error| format!("RRS_RUNTIME_HTTP_JSON:{error}"))?;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len(),
    );
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|error| format!("RRS_RUNTIME_HTTP_WRITE:{error}"))
}

fn parse_hex32(value: &str) -> Option<[u8; 32]> {
    let body = value.strip_prefix("0x")?;
    if body.len() != 64
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(output)
}

fn parse_hex20(value: &str) -> Option<[u8; 20]> {
    let body = value.strip_prefix("0x")?;
    if body.len() != 40
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut output = [0_u8; 20];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    use serde_json::json;

    use super::{
        RuntimeHttpCommand, RuntimeHttpServer, RuntimeHttpState, decode_command,
        runtime_http_command_channel,
    };

    fn request(address: SocketAddr, request: &str) -> String {
        let mut stream = TcpStream::connect(address).expect("connect");
        stream.write_all(request.as_bytes()).expect("write");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("timeout");
        let mut output = String::new();
        stream.read_to_string(&mut output).expect("read");
        output
    }

    #[test]
    fn accepted_nonblocking_socket_waits_for_split_http_header() {
        let state = RuntimeHttpState::new(json!({
            "info":{"runtimeId":"0x11"},
            "health":{},
            "metrics":{},
        }))
        .expect("state");
        let server = RuntimeHttpServer::bind("127.0.0.1:0".parse().expect("address"), state)
            .expect("server");
        let mut stream = TcpStream::connect(server.local_address()).expect("connect");
        stream
            .write_all(b"GET /api/info HTTP/1.1\r\n")
            .expect("first");
        std::thread::sleep(Duration::from_millis(10));
        stream
            .write_all(b"host: localhost\r\n\r\n")
            .expect("second");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("timeout");
        let mut output = String::new();
        stream.read_to_string(&mut output).expect("read");
        assert!(output.starts_with("HTTP/1.1 200"), "{output}");
    }

    #[test]
    fn account_status_decodes_standard_percent_encoded_token_list() {
        let (sender, receiver) = runtime_http_command_channel();
        let state =
            RuntimeHttpState::with_commands(json!({"info":{},"health":{},"metrics":{}}), sender)
                .expect("state");
        let worker = std::thread::spawn(move || match receiver.recv().expect("command") {
            RuntimeHttpCommand::AccountStatus {
                hub_entity_id,
                counterparty,
                token_ids,
                response,
                ..
            } => {
                assert_eq!(hub_entity_id, [0x11; 32]);
                assert_eq!(counterparty.as_bytes(), &[0x22; 32]);
                assert_eq!(
                    token_ids
                        .iter()
                        .map(|token| u32::from(token.get()))
                        .collect::<Vec<_>>(),
                    vec![1, 3, 2],
                );
                let _ = response.send(Ok(json!({"success":true,"tokens":[]})));
            }
            _ => panic!("unexpected command"),
        });
        let server = RuntimeHttpServer::bind("127.0.0.1:0".parse().expect("address"), state)
            .expect("server");
        let status = request(
            server.local_address(),
            &format!(
                "GET /api/account/status?hubEntityId=0x{}&counterpartyEntityId=0x{}&tokenIds=1%2C3%2C2 HTTP/1.1\r\nhost: local\r\n\r\n",
                "11".repeat(32),
                "22".repeat(32),
            ),
        );
        assert!(status.starts_with("HTTP/1.1 200"), "{status}");
        assert!(status.contains("\"success\":true"), "{status}");
        worker.join().expect("status worker");
    }

    #[test]
    fn serves_owned_snapshot_and_quiesces() {
        let (sender, receiver) = runtime_http_command_channel();
        let state = RuntimeHttpState::with_commands(
            json!({
                "info":{"runtimeId":"0x11","entityId":format!("0x{}", "11".repeat(32))},
                "health":{"height":0,"runtime":{"halted":false}},
                "metrics":{}
            }),
            sender,
        )
        .expect("state");
        let profile_worker = std::thread::spawn(move || {
            match receiver.recv().expect("profile command") {
                RuntimeHttpCommand::EntityProfile {
                    entity_id,
                    entity_id_text,
                    response,
                } => {
                    assert_eq!(entity_id, [0x11; 32]);
                    let _ = response.send(Ok(Some(json!({"entityId":entity_id_text}))));
                }
                _ => panic!("unexpected profile command"),
            }
            match receiver.recv().expect("market command") {
                RuntimeHttpCommand::MarketCatalog {
                    hub_entity_id,
                    hub_entity_id_text,
                    response,
                } => {
                    assert_eq!(hub_entity_id, [0x11; 32]);
                    let _ = response.send(Ok(json!({
                        "format":"market-pair-catalog",
                        "hubEntityId":hub_entity_id_text,
                        "pairIds":[],
                    })));
                }
                _ => panic!("unexpected market command"),
            }
        });
        let server = RuntimeHttpServer::bind("127.0.0.1:0".parse().expect("address"), state)
            .expect("server");
        let info = request(
            server.local_address(),
            "GET /api/info HTTP/1.1\r\nhost: localhost\r\n\r\n",
        );
        assert!(info.starts_with("HTTP/1.1 200"));
        assert!(info.contains("\"runtimeId\":\"0x11\""));
        let profile = request(
            server.local_address(),
            &format!(
                "GET /api/gossip/profile?entityId=0x{} HTTP/1.1\r\nhost: local\r\n\r\n",
                "11".repeat(32),
            ),
        );
        assert!(profile.contains("\"found\":true"));
        assert!(profile.contains("\"peers\":[]"));
        let market = request(
            server.local_address(),
            "GET /api/market/catalog HTTP/1.1\r\nhost: localhost\r\n\r\n",
        );
        assert!(market.starts_with("HTTP/1.1 200"), "{market}");
        assert!(market.contains("market-pair-catalog"), "{market}");
        profile_worker.join().expect("profile worker");
        let stopped = request(
            server.local_address(),
            "POST /api/control/core/quiesce HTTP/1.1\r\nhost: localhost\r\ncontent-length: 0\r\n\r\n",
        );
        assert!(stopped.starts_with("HTTP/1.1 200"));
        assert!(server.state().quiescing());
    }

    #[test]
    fn offchain_faucet_rejects_invalid_user_before_runtime_dispatch() {
        let state =
            RuntimeHttpState::new(json!({"info":{},"health":{},"metrics":{}})).expect("state");
        let server = RuntimeHttpServer::bind("127.0.0.1:0".parse().expect("address"), state)
            .expect("server");
        let body = format!(
            "{{\"userEntityId\":\"dev-ready-invalid-entity\",\"hubEntityId\":\"0x{}\",\"tokenId\":1,\"amount\":\"1\"}}",
            "11".repeat(32)
        );
        let response = request(
            server.local_address(),
            &format!(
                concat!(
                    "POST /api/faucet/offchain HTTP/1.1\r\nhost: local\r\n",
                    "content-type: application/json\r\ncontent-length: {}\r\n\r\n{}"
                ),
                body.len(),
                body
            ),
        );
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
        assert!(
            response.contains("\"code\":\"FAUCET_INVALID_USER_ENTITY_ID\""),
            "{response}"
        );
    }

    #[test]
    fn decodes_the_exact_native_bootstrap_credit_command() {
        let entity_id = format!("0x{}", "11".repeat(32));
        let peer_id = format!("0x{}", "22".repeat(32));
        let command = decode_command(&json!({
            "commandId":format!("bootstrap-credit:{peer_id}:1"),
            "entityInputs":[{
                "entityId":entity_id,
                "signerId":"0x3333333333333333333333333333333333333333",
                "entityTxs":[{
                    "type":"extendCredit",
                    "data":{
                        "counterpartyEntityId":peer_id,
                        "tokenId":1,
                        "amount":{"__xlnType":"BigInt","value":"1000000"}
                    }
                }]
            }]
        }))
        .expect("canonical bootstrap credit");
        assert!(command.command_id.starts_with("bootstrap-credit:"));
        assert_eq!(command.entity_inputs.len(), 1);
        assert_eq!(
            command.entity_inputs[0].signer_id(),
            "0x3333333333333333333333333333333333333333"
        );
        assert!(command.entity_inputs[0].has_entity_txs());
    }
}
