use super::*;

/// Capture the committed adapter domain on the writer, then perform bounded
/// pinned-block external reads outside that writer. A wallet query cannot
/// suspend Account processing while waiting for an RPC peer.
pub(super) fn serve(
    stream: &mut TcpStream,
    state: &RuntimeHttpState,
    body: &[u8],
) -> Result<(), String> {
    if body.len() > 32 * 1024 {
        return response(
            stream,
            413,
            &json!({"error":"EXTERNAL_WALLET_SNAPSHOT_BODY_TOO_LARGE"}),
        );
    }
    let body: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => {
            return response(
                stream,
                400,
                &json!({"error":"EXTERNAL_WALLET_SNAPSHOT_JSON_INVALID"}),
            );
        }
    };
    let entity_id = body
        .get("entityId")
        .and_then(Value::as_str)
        .map(|text| text.trim().to_ascii_lowercase())
        .and_then(|text| parse_hex32(&text));
    let Some(entity_id) = entity_id else {
        return response(stream, 400, &json!({"error":"Invalid entityId"}));
    };
    let sender = state
        .commands
        .as_ref()
        .ok_or("RRS_RUNTIME_HTTP_COMMANDS_UNAVAILABLE")?;
    let (reply, result) = sync_channel(1);
    sender
        .send(RuntimeHttpCommand::WalletSnapshotDomain {
            entity_id,
            response: reply,
        })
        .map_err(|_| "RRS_RUNTIME_HTTP_COMMAND_SEND")?;
    let row = match result.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(row)) => row,
        Ok(Err(error)) => return response(stream, 503, &json!({"error":error})),
        Err(_) => return response(stream, 503, &json!({"error":"snapshot domain unavailable"})),
    };
    let mut owned = stream.try_clone().map_err(|error| error.to_string())?;
    thread::Builder::new()
        .name("native-wallet-snapshot".into())
        .spawn(move || {
            let result = row
                .as_object()
                .ok_or_else(|| xln_rscore_runtime::WalletSnapshotError {
                    status: 500,
                    message: "snapshot domain invalid".into(),
                })
                .and_then(|domain| xln_rscore_runtime::read_wallet_snapshot(domain, &body));
            let sent = match result {
                Ok(value) => response(&mut owned, 200, &value),
                Err(error) => response(&mut owned, error.status, &json!({"error":error.message})),
            };
            if let Err(error) = sent {
                eprintln!("[WARN][runtime.wallet_snapshot] {error}");
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}
