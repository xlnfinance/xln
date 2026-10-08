use std::io::Write;
use std::net::TcpStream;
use tungstenite::{WebSocket, handshake::server::create_response, http::Request, protocol::Role};

/// HTTP parser already consumed the complete upgrade request. Validate the
/// original headers with tungstenite, then transfer the socket without a
/// second read of the handshake or any Runtime state on the network thread.
pub fn accept(mut stream: TcpStream, bytes: &[u8]) -> Result<WebSocket<TcpStream>, String> {
    let raw = std::str::from_utf8(bytes).map_err(|_| "RADAPTER_UPGRADE_UTF8")?;
    let mut lines = raw.split("\r\n");
    let first = lines.next().ok_or("RADAPTER_UPGRADE_REQUEST")?;
    let parts: Vec<_> = first.split(' ').collect();
    let [method, target, version] = parts.as_slice() else {
        return Err("RADAPTER_UPGRADE_REQUEST".into());
    };
    if *method != "GET" || *target != "/rpc" || *version != "HTTP/1.1" {
        return Err("RADAPTER_UPGRADE_ROUTE".into());
    }
    let mut builder = Request::builder().method(*method).uri(*target);
    for line in lines {
        if line.is_empty() {
            break;
        }
        let (key, value) = line.split_once(':').ok_or("RADAPTER_UPGRADE_HEADER")?;
        builder = builder.header(key, value.trim());
    }
    let request = builder.body(()).map_err(|e| e.to_string())?;
    let response = create_response(&request).map_err(|e| e.to_string())?;
    let mut encoded = format!("HTTP/1.1 {}\r\n", response.status());
    for (name, value) in response.headers() {
        encoded.push_str(&format!(
            "{}: {}\r\n",
            name,
            value.to_str().map_err(|e| e.to_string())?
        ));
    }
    encoded.push_str("\r\n");
    stream
        .write_all(encoded.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(WebSocket::from_raw_socket(stream, Role::Server, None))
}
