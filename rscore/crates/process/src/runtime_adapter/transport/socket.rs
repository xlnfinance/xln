//! WebSocket transport only. Every state read and command is serialized through
//! the existing Runtime writer. No HTTP/client thread runs financial reducers.
use crate::runtime_adapter::auth::{AdapterAuthConfig, AdapterSession, authenticate};
use crate::runtime_http::RuntimeHttpCommand;
use serde_json::{Value, json};
use std::net::TcpStream;
use std::sync::{
    Arc,
    mpsc::{SyncSender, sync_channel},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tungstenite::{Error, Message, WebSocket};

pub enum AdapterQuery {
    AdoptCustody {
        owner: crate::runtime_adapter::custody::custody_worker::CustodyOwner,
    },
    Session {
        lane_id: String,
    },
    Read {
        path: String,
        query: Value,
    },
    Send {
        lane_id: String,
        expires_at_ms: Option<u64>,
        request: Value,
    },
    Control {
        action: Value,
    },
}
pub struct AdapterWork {
    pub query: AdapterQuery,
    pub authorized_until: Option<u64>,
    pub reply: SyncSender<Result<Value, String>>,
}
pub fn now_ms() -> Result<u64, String> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis(),
    )
    .map_err(|e| e.to_string())
}
fn query(sender: &SyncSender<RuntimeHttpCommand>, query: AdapterQuery) -> Result<Value, String> {
    query_authorized(sender, query, None)
}
fn query_authorized(
    sender: &SyncSender<RuntimeHttpCommand>,
    query: AdapterQuery,
    authorized_until: Option<u64>,
) -> Result<Value, String> {
    let (tx, rx) = sync_channel(1);
    sender
        .try_send(RuntimeHttpCommand::Adapter(AdapterWork {
            query,
            authorized_until,
            reply: tx,
        }))
        .map_err(|_| "E_RATE_LIMITED:writer busy".to_string())?;
    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "E_INTERNAL:writer deadline".to_string())?
}
fn send(ws: &mut WebSocket<TcpStream>, value: Value) -> Result<(), String> {
    ws.send(Message::Text(value.to_string().into()))
        .map_err(|e| e.to_string())
}
fn response(
    ws: &mut WebSocket<TcpStream>,
    id: &str,
    result: Result<Value, String>,
) -> Result<(), String> {
    let value = match result {
        Ok(payload) => json!({"v":1,"inReplyTo":id,"ok":true,"payload":payload}),
        Err(message) => {
            let code = message
                .split(':')
                .next()
                .filter(|s| s.starts_with("E_"))
                .unwrap_or("E_INTERNAL");
            json!({"v":1,"inReplyTo":id,"ok":false,"error":{"code":code,"message":message,"retryable":matches!(code,"E_COMMAND_PENDING"|"E_RATE_LIMITED")}})
        }
    };
    send(ws, value)
}
fn dispatch(
    sender: &SyncSender<RuntimeHttpCommand>,
    session: &AdapterSession,
    request: &Value,
) -> Result<Value, String> {
    if session
        .expires_at_ms
        .is_some_and(|expiry| now_ms().map_or(true, |now| now >= expiry))
    {
        return Err("E_UNAUTHORIZED:capability expired".into());
    }
    match request["op"].as_str().ok_or("E_BAD_QUERY:op")? {
        "read" => query_authorized(
            sender,
            AdapterQuery::Read {
                path: request["path"].as_str().ok_or("E_BAD_QUERY:path")?.into(),
                query: request.get("query").cloned().unwrap_or_else(|| json!({})),
            },
            session.expires_at_ms,
        ),
        "send" if session.level == "admin" => query_authorized(
            sender,
            AdapterQuery::Send {
                lane_id: session.lane_id.clone(),
                expires_at_ms: if session.lane_kind == "owner" {
                    None
                } else {
                    session.expires_at_ms
                },
                request: request.clone(),
            },
            session.expires_at_ms,
        ),
        "control" if session.level == "admin" => query_authorized(
            sender,
            AdapterQuery::Control {
                action: request["action"].clone(),
            },
            session.expires_at_ms,
        ),
        "send" | "control" => Err("E_UNAUTHORIZED:admin required".into()),
        _ => Err("E_BAD_QUERY:unsupported RuntimeAdapter operation".into()),
    }
}
pub fn serve(
    mut ws: WebSocket<TcpStream>,
    config: Arc<AdapterAuthConfig>,
    sender: SyncSender<RuntimeHttpCommand>,
    custody: Option<Arc<crate::runtime_adapter::custody::custody_socket::CustodyConfig>>,
) -> Result<(), String> {
    ws.get_mut()
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|e| e.to_string())?;
    ws.get_mut()
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut session: Option<AdapterSession> = None;
    let mut latest_tick = Value::Null;
    let mut custody_job: Option<crate::runtime_adapter::custody::custody_socket::CustodyJob> = None;
    loop {
        match ws.read() {
            Ok(Message::Binary(bytes)) => {
                if bytes.len() > 16 * 1024 * 1024 {
                    return Err("E_BAD_QUERY:message size".into());
                }
                let request =
                    xln_rscore_runtime::decode_storage_payload(&bytes).map_err(|error| {
                        format!("E_BAD_QUERY:RADAPTER_WIRE_MESSAGEPACK_REQUIRED:{error}")
                    })?;
                let id = request["id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                    .ok_or("E_BAD_QUERY:id")?;
                if request["v"] != 1 {
                    response(&mut ws, id, Err("E_BAD_QUERY:protocol version".into()))?;
                    continue;
                }
                if request["op"] == "brainvault-derive" || request["op"] == "brainvault-cancel" {
                    let authorized = session.as_ref().is_some_and(|s| {
                        s.level == "admin"
                            && s.expires_at_ms
                                .is_none_or(|expiry| now_ms().is_ok_and(|now| now < expiry))
                    });
                    if !authorized {
                        response(&mut ws, id, Err("E_UNAUTHORIZED:admin required".into()))?;
                        continue;
                    }
                    if request["op"] == "brainvault-cancel" {
                        let cancelled = custody_job
                            .as_ref()
                            .is_some_and(|job| request["jobId"] == job.job_id);
                        if cancelled {
                            let mut job = custody_job.take().expect("matched job");
                            job.cancel()?;
                            response(
                                &mut ws,
                                &job.request_id,
                                Err("E_INTERNAL:BRAINVAULT_DERIVATION_ABORTED".into()),
                            )?;
                        }
                        response(&mut ws, id, Ok(json!({"cancelled":cancelled})))?;
                    } else if custody_job.is_some() {
                        response(
                            &mut ws,
                            id,
                            Err(
                                "E_COMMAND_PENDING:a BrainVault derivation is already running"
                                    .into(),
                            ),
                        )?;
                    } else {
                        let result = custody
                            .as_ref()
                            .ok_or("E_INTERNAL:native BrainVault unavailable".to_owned())
                            .and_then(|config| {
                                crate::runtime_adapter::custody::custody_socket::CustodyJob::start(
                                    config,
                                    &request,
                                    session.as_ref().and_then(|s| s.expires_at_ms),
                                )
                            });
                        match result {
                            Ok(job) => custody_job = Some(job),
                            Err(error) => response(&mut ws, id, Err(error))?,
                        }
                    }
                    continue;
                }
                let result = if request["op"] == "auth" {
                    if let Some(mut job) = custody_job.take() {
                        job.cancel()?;
                    }

                    // Failed re-authentication must revoke this socket's previous authority.
                    session = None;
                    // Canonical TS reads this process configuration on each auth, not on every read.
                    let revoked = std::env::var("XLN_RADAPTER_REVOKED_JTIS")
                        .unwrap_or_default()
                        .split(',')
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .collect::<std::collections::BTreeSet<_>>();
                    authenticate(&config, &request, now_ms()?, &revoked).and_then(|authenticated| {
                        let mut payload = query(
                            &sender,
                            AdapterQuery::Session {
                                lane_id: authenticated.lane_id.clone(),
                            },
                        )?;
                        let fields = payload
                            .as_object_mut()
                            .ok_or("RADAPTER_SESSION_RESPONSE_INVALID")?;
                        let proof = authenticated
                            .identity_proof
                            .as_object()
                            .ok_or("RADAPTER_IDENTITY_INVALID")?;
                        fields.extend(proof.clone());
                        fields.insert("expiresAtMs".into(), json!(authenticated.expires_at_ms));
                        fields.insert("authLevel".into(), json!(authenticated.level));
                        fields.insert("commandLaneKind".into(), json!(authenticated.lane_kind));
                        session = Some(authenticated);
                        Ok(payload)
                    })
                } else {
                    session
                        .as_ref()
                        .ok_or_else(|| "E_UNAUTHORIZED:authenticate first".to_string())
                        .and_then(|s| dispatch(&sender, s, &request))
                };
                response(&mut ws, id, result)?;
            }
            Ok(Message::Text(_)) => {
                return Err("E_BAD_QUERY:RADAPTER_WIRE_MESSAGEPACK_REQUIRED".into());
            }
            Ok(Message::Close(_)) | Err(Error::ConnectionClosed) | Err(Error::AlreadyClosed) => {
                return Ok(());
            }
            Ok(Message::Ping(data)) => {
                ws.send(Message::Pong(data)).map_err(|e| e.to_string())?;
            }
            Err(Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Ok(_) => {}
            Err(error) => return Err(error.to_string()),
        }
        if let Some(job) = custody_job.as_mut() {
            use crate::runtime_adapter::custody::custody_socket::CustodyPoll;
            match job.poll() {
                CustodyPoll::Pending => {}
                CustodyPoll::Progress(progress) => send(&mut ws, progress)?,
                CustodyPoll::Failed(error) => {
                    let mut job = custody_job.take().expect("polled job");
                    job.cancel()?;
                    response(&mut ws, &job.request_id, Err(format!("E_INTERNAL:{error}")))?;
                }
                CustodyPoll::Adopt(owner) => {
                    let job = custody_job.take().expect("polled job");
                    let result = query_authorized(
                        &sender,
                        AdapterQuery::AdoptCustody { owner },
                        job.expires_at_ms,
                    );
                    response(&mut ws, &job.request_id, result)?;
                }
            }
        }
        if let Some(authenticated) = session.as_ref() {
            if authenticated
                .expires_at_ms
                .is_some_and(|expiry| now_ms().map_or(true, |now| now >= expiry))
            {
                ws.close(None).map_err(|e| e.to_string())?;
                return Ok(());
            }
            let status = query(
                &sender,
                AdapterQuery::Session {
                    lane_id: authenticated.lane_id.clone(),
                },
            )?;
            let tick = json!({"v":1,"op":"tick","height":status["currentHeight"],"commandReady":status["commandReady"],"commandReadyReason":status["commandReadyReason"]});
            if tick != latest_tick {
                send(&mut ws, tick.clone())?;
                latest_tick = tick;
            }
        }
    }
}

#[cfg(test)]
#[path = "socket_tests.rs"]
mod tests;
