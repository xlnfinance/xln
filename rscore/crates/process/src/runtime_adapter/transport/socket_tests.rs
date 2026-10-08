use super::*;
#[test]
fn actual_websocket_accepts_canonical_ts_binary_auth_request() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/runtime-adapter-auth-v1.json"
    ))
    .unwrap();
    let config = AdapterAuthConfig::new(
        fixture["authSeed"].as_str().unwrap().into(),
        fixture["runtimeSeed"].as_str().unwrap(),
        fixture["runtimeId"].as_str().unwrap(),
        None,
        86_400_000,
    )
    .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, _receiver) = sync_channel(1);
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let ws = tungstenite::accept(stream).unwrap();
        serve(ws, Arc::new(config), sender, None)
    });
    let stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let (mut ws, _) = tungstenite::client(format!("ws://{address}/rpc"), stream).unwrap();
    let bytes =
        hex::decode(include_str!("../../../../../fixtures/runtime-adapter-binary-auth.hex").trim())
            .unwrap();
    ws.send(Message::Binary(bytes.into())).unwrap();
    let received = ws.read();
    let _ = ws.close(None);
    drop(ws);
    let _ = server.join();
    let response = received.expect("binary auth must receive a response, not time out");
    let Message::Text(text) = response else {
        panic!("canonical server JSON response required")
    };
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["inReplyTo"], "auth-binary-regression");
    assert_eq!(value["error"]["code"], "E_UNAUTHORIZED");
}
