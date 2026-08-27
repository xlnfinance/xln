use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::super::RuntimeTransportError;
use super::SharedIngress;

pub(super) fn run(listener: TcpListener, shared: Arc<SharedIngress>) {
    let mut serial = 0_u64;
    let mut sessions = Vec::<JoinHandle<()>>::new();
    while !shared.stop.load(Ordering::Acquire) {
        reap_sessions(&mut sessions, &shared);
        match listener.accept() {
            Ok((stream, _)) => {
                if let Err(error) = stream.set_nonblocking(false) {
                    set_fatal(&shared, &format!("session-blocking:{error}"));
                    break;
                }
                serial = match serial.checked_add(1) {
                    Some(value) => value,
                    None => {
                        set_fatal(&shared, "connection-id-overflow");
                        break;
                    }
                };
                shared
                    .counters
                    .accepted_connections
                    .fetch_add(1, Ordering::Relaxed);
                if let Err(error) = register_socket(&shared, serial, &stream) {
                    set_fatal(&shared, &error.to_string());
                    break;
                }
                let session_shared = Arc::clone(&shared);
                match thread::Builder::new()
                    .name(format!("rrs-direct-peer-{serial}"))
                    .spawn(move || super::session::run(stream, serial, session_shared))
                {
                    Ok(handle) => sessions.push(handle),
                    Err(error) => {
                        remove_socket(&shared, serial);
                        set_fatal(&shared, &format!("session-spawn:{error}"));
                        break;
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => {
                set_fatal(&shared, &format!("accept:{error}"));
                break;
            }
        }
    }
    close_registered_sockets(&shared);
    for session in sessions {
        if session.join().is_err() {
            set_fatal(&shared, "session-panicked");
        }
    }
}

fn reap_sessions(sessions: &mut Vec<JoinHandle<()>>, shared: &SharedIngress) {
    let mut index = 0;
    while index < sessions.len() {
        if sessions[index].is_finished() {
            let handle = sessions.swap_remove(index);
            if handle.join().is_err() {
                set_fatal(shared, "session-panicked");
            }
        } else {
            index += 1;
        }
    }
}

fn register_socket(
    shared: &SharedIngress,
    serial: u64,
    stream: &TcpStream,
) -> Result<(), RuntimeTransportError> {
    let clone = stream
        .try_clone()
        .map_err(|error| RuntimeTransportError::WebSocket(error.to_string()))?;
    shared
        .sockets
        .lock()
        .map_err(|_| RuntimeTransportError::Inbound("socket-lock".into()))?
        .insert(serial, clone);
    Ok(())
}

pub(super) fn remove_socket(shared: &SharedIngress, serial: u64) {
    if let Ok(mut sockets) = shared.sockets.lock() {
        sockets.remove(&serial);
    }
}

pub(super) fn close_registered_sockets(shared: &SharedIngress) {
    if let Ok(sockets) = shared.sockets.lock() {
        for socket in sockets.values() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

fn set_fatal(shared: &SharedIngress, error: &str) {
    shared.stop.store(true, Ordering::Release);
    if let Ok(mut slot) = shared.fatal_error.lock()
        && slot.is_none()
    {
        *slot = Some(error.into());
    }
}
