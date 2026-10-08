//! Authenticated native operator boundary; canonical deployment runs in a private Bun worker.
use super::*;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn reply(stream: &mut TcpStream, status: u16, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let header = format!(
        "HTTP/1.1 {status} Response\r\ncontent-type: application/json\r\naccess-control-allow-origin: *\r\naccess-control-allow-methods: GET, POST, OPTIONS\r\naccess-control-allow-headers: authorization, content-type\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|e| e.to_string())
}
fn header<'a>(bytes: &'a [u8], name: &str) -> Option<&'a str> {
    std::str::from_utf8(bytes)
        .ok()?
        .split("\r\n\r\n")
        .next()?
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find_map(|(key, value)| key.eq_ignore_ascii_case(name).then(|| value.trim()))
}
fn failed(status: &Arc<Mutex<Value>>, message: &str) -> Result<(), String> {
    let mut row = status.lock().map_err(|_| "STACK_MANAGER_STATUS_LOCK")?;
    row["phase"] = json!("failed");
    row["active"] = json!(false);
    row["error"] = json!(message);
    Ok(())
}
fn worker(input: Value, status: Arc<Mutex<Value>>) -> Result<Value, String> {
    let executable = std::env::var("XLN_STACK_MANAGER_BUN_PATH")
        .map_err(|_| "STACK_MANAGER_BUN_PATH_REQUIRED")?;
    let script = std::env::var("XLN_STACK_MANAGER_WORKER_PATH")
        .map_err(|_| "STACK_MANAGER_WORKER_PATH_REQUIRED")?;
    if !std::path::Path::new(&script).is_absolute() {
        return Err("STACK_MANAGER_WORKER_PATH_INVALID".into());
    }
    let mut child = Command::new(executable)
        .arg(script)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "STACK_MANAGER_WORKER_SPAWN_FAILED")?;
    let group = child.id();
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut stdin = child.stdin.take().ok_or("STACK_MANAGER_WORKER_STDIN")?;
    let encoded = serde_json::to_vec(&input).map_err(|_| "STACK_MANAGER_WORKER_INPUT")?;
    if let Err(error) = stdin.write_all(&encoded) {
        crate::runtime_adapter::custody::custody_group::terminate(&mut child, group)?;
        return Err(format!("STACK_MANAGER_WORKER_WRITE:{error}"));
    }
    drop(stdin);
    let stdout = child.stdout.take().ok_or("STACK_MANAGER_WORKER_STDOUT")?;
    let (sender, receiver) = sync_channel(1);
    thread::spawn(move || {
        let result = (|| {
            let mut result = None;
            let mut count = 0;
            for line in BufReader::new(stdout).lines() {
                let line = line.map_err(|_| "STACK_MANAGER_WORKER_READ")?;
                count += line.len();
                if count > 1024 * 1024 {
                    return Err("STACK_MANAGER_WORKER_OUTPUT_LIMIT".to_string());
                }
                let message: Value =
                    serde_json::from_str(&line).map_err(|_| "STACK_MANAGER_WORKER_PROTOCOL")?;
                match message["type"].as_str() {
                    Some("phase") => {
                        let phase = message["phase"]
                            .as_str()
                            .ok_or("STACK_MANAGER_WORKER_PHASE")?;
                        if ![
                            "preflight",
                            "deploying",
                            "verifying",
                            "persisting",
                            "complete",
                        ]
                        .contains(&phase)
                        {
                            return Err("STACK_MANAGER_WORKER_PHASE".into());
                        }
                        *status.lock().map_err(|_| "STACK_MANAGER_STATUS_LOCK")? = json!({"phase":phase,"active":phase != "complete","updatedAt":message["updatedAt"]});
                    }
                    Some("result") => result = Some(message["value"].clone()),
                    Some("error") => {
                        return Err(message["error"]
                            .as_str()
                            .ok_or("STACK_MANAGER_WORKER_ERROR")?
                            .to_string());
                    }
                    _ => return Err("STACK_MANAGER_WORKER_PROTOCOL".into()),
                }
            }
            result.ok_or("STACK_MANAGER_WORKER_RESULT_MISSING".to_string())
        })();
        let _ = sender.send(result);
    });
    match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(Ok(value)) => loop {
            if let Some(exit) = child.try_wait().map_err(|_| "STACK_MANAGER_WORKER_WAIT")? {
                return if exit.success() {
                    Ok(value)
                } else {
                    Err("STACK_MANAGER_WORKER_EXIT_FAILED".into())
                };
            }
            if Instant::now() >= deadline {
                crate::runtime_adapter::custody::custody_group::terminate(&mut child, group)?;
                return Err("STACK_MANAGER_WORKER_TIMEOUT".into());
            }
            thread::sleep(Duration::from_millis(10));
        },
        Ok(Err(error)) => {
            crate::runtime_adapter::custody::custody_group::terminate(&mut child, group)?;
            Err(error)
        }
        Err(_) => {
            crate::runtime_adapter::custody::custody_group::terminate(&mut child, group)?;
            Err("STACK_MANAGER_WORKER_TIMEOUT".into())
        }
    }
}

pub(super) fn serve(
    stream: &mut TcpStream,
    state: &RuntimeHttpState,
    method: &str,
    target: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if method == "OPTIONS" {
        return reply(stream, 200, &json!({"ok":true}));
    }
    let config = state.adapter.as_ref().ok_or("RADAPTER_NOT_CONFIGURED")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "STACK_MANAGER_CLOCK")?
        .as_millis() as u64;
    let token = header(bytes, "authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    if let Err(error) = crate::runtime_adapter::auth::authorize_http_admin(config, token, now) {
        return reply(stream, 403, &json!({"ok":false,"error":error}));
    }
    let deploy = method == "POST" && target == "/api/control/stack-manager/deploy";
    if !(deploy || method == "GET" && target.split('?').next() == Some("/api/stack-manager/status"))
    {
        return reply(
            stream,
            405,
            &json!({"ok":false,"error":"STACK_MANAGER_METHOD_INVALID"}),
        );
    }
    let query: std::collections::BTreeMap<_, _> =
        form_urlencoded::parse(target.split_once('?').map_or("", |(_, q)| q).as_bytes())
            .into_owned()
            .collect();
    let body = if deploy {
        let body = request_body(bytes)?;
        if body.len() > 32 * 1024 {
            return reply(
                stream,
                413,
                &json!({"ok":false,"error":"STACK_MANAGER_BODY_LIMIT"}),
            );
        }
        match serde_json::from_slice::<Value>(body) {
            Ok(value) => value,
            Err(_) => {
                return reply(
                    stream,
                    400,
                    &json!({"ok":false,"error":"STACK_MANAGER_JSON_INVALID"}),
                );
            }
        }
    } else {
        Value::Null
    };
    let signer_id = if deploy {
        body["signerId"].as_str().map(str::to_string)
    } else {
        query.get("signerId").cloned()
    };
    if deploy && signer_id.is_none() {
        return reply(
            stream,
            400,
            &json!({"ok":false,"error":"STACK_MANAGER_SIGNER_REQUIRED"}),
        );
    }
    let (sender, receiver) = sync_channel(1);
    state
        .commands
        .as_ref()
        .ok_or("RRS_RUNTIME_HTTP_COMMANDS_UNAVAILABLE")?
        .send(RuntimeHttpCommand::StackManagerSigner {
            signer_id: signer_id.clone(),
            response: sender,
        })
        .map_err(|_| "STACK_MANAGER_WRITER_CLOSED")?;
    let (signer_ids, key) = match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => return reply(stream, 400, &json!({"ok":false,"error":error})),
        Err(_) => {
            return reply(
                stream,
                503,
                &json!({"ok":false,"error":"STACK_MANAGER_WRITER_TIMEOUT"}),
            );
        }
    };
    if !deploy && query.is_empty() {
        return reply(
            stream,
            200,
            &json!({"ok":true,"status":state.stack_manager.lock().map_err(|_| "STACK_MANAGER_STATUS_LOCK")?.clone(),"signerIds":signer_ids}),
        );
    }
    let input = if deploy {
        json!({"op":"deploy","request":body,"signerPrivateKey":format!("0x{}",hex::encode(key.ok_or("STACK_MANAGER_SIGNER_NOT_OWNED")?))})
    } else {
        json!({"op":"probe","rpcUrl":query.get("rpcUrl"),"signerId":signer_id})
    };
    if deploy {
        let mut status = state
            .stack_manager
            .lock()
            .map_err(|_| "STACK_MANAGER_STATUS_LOCK")?;
        if status["active"] == true {
            return reply(
                stream,
                409,
                &json!({"ok":false,"error":"STACK_MANAGER_DEPLOYMENT_ACTIVE"}),
            );
        }
        status["active"] = json!(true);
        status["phase"] = json!("preflight");
    }
    let status = state.stack_manager.clone();
    let mut socket = stream.try_clone().map_err(|e| e.to_string())?;
    thread::spawn(move || {
        let result = worker(input, status.clone());
        let output = match result {
            Ok(value) if deploy => (200, json!({"ok":true,"result":value})),
            Ok(value) => match status.lock() {
                Ok(row) => (
                    200,
                    json!({"ok":true,"status":row.clone(),"signerIds":signer_ids,"probe":value}),
                ),
                Err(_) => (503, json!({"ok":false,"error":"STACK_MANAGER_STATUS_LOCK"})),
            },
            Err(error) => {
                if deploy && let Err(lock_error) = failed(&status, &error) {
                    eprintln!("[ERROR][stack-manager] {lock_error}");
                }
                (400, json!({"ok":false,"error":error}))
            }
        };
        if let Err(error) = reply(&mut socket, output.0, &output.1) {
            eprintln!("[ERROR][stack-manager] {error}");
        }
    });
    Ok(())
}
