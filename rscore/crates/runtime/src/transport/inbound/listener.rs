use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::reactor::{ReactorHandle, ReactorIngress};
use super::{SharedIngress, session_failed};

// Admission is CPU-heavy (ECDSA verification/signing plus X25519), while the
// socket reactors own already-authenticated peers. Keep enough bounded workers
// to admit a 5k peer burst without changing authentication or session ordering.
const HANDSHAKE_WORKERS: usize = 16;
const SOCKET_REACTORS: usize = 8;
const HANDSHAKE_QUEUE: usize = 8_192;

struct HandshakeJob {
    stream: TcpStream,
    serial: u64,
}

pub(super) fn run(listener: TcpListener, shared: Arc<SharedIngress>) {
    let Some(reactors) = start_reactors(&shared) else {
        return;
    };
    let reactor_ingress = reactors
        .iter()
        .map(|reactor| reactor.ingress.clone())
        .collect::<Vec<_>>();
    let (handshake_tx, handshake_rx) = sync_channel(HANDSHAKE_QUEUE);
    let handshake_rx = Arc::new(Mutex::new(handshake_rx));
    let handshakes = start_handshake_workers(
        Arc::clone(&shared),
        Arc::clone(&handshake_rx),
        reactor_ingress,
    );
    let mut serial = 0_u64;
    while !shared.stop.load(Ordering::Acquire) {
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
                if handshake_tx.send(HandshakeJob { stream, serial }).is_err() {
                    remove_socket(&shared, serial);
                    set_fatal(&shared, "handshake-workers-closed");
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => {
                set_fatal(&shared, &format!("accept:{error}"));
                break;
            }
        }
    }
    close_registered_sockets(&shared);
    drop(handshake_tx);
    for worker in handshakes {
        if worker.join().is_err() {
            set_fatal(&shared, "handshake-worker-panicked");
        }
    }
    for reactor in &reactors {
        reactor.ingress.wake();
    }
    for reactor in reactors {
        if let Err(error) = reactor.join() {
            set_fatal(&shared, &error.to_string());
        }
    }
}

fn start_reactors(shared: &Arc<SharedIngress>) -> Option<Vec<ReactorHandle>> {
    let mut reactors = Vec::with_capacity(SOCKET_REACTORS);
    for index in 0..SOCKET_REACTORS {
        match ReactorHandle::spawn(index, Arc::clone(shared)) {
            Ok(reactor) => reactors.push(reactor),
            Err(error) => {
                set_fatal(shared, &error.to_string());
                for reactor in &reactors {
                    reactor.ingress.wake();
                }
                for reactor in reactors {
                    let _ = reactor.join();
                }
                return None;
            }
        }
    }
    Some(reactors)
}

fn start_handshake_workers(
    shared: Arc<SharedIngress>,
    receiver: Arc<Mutex<Receiver<HandshakeJob>>>,
    reactors: Vec<ReactorIngress>,
) -> Vec<JoinHandle<()>> {
    (0..HANDSHAKE_WORKERS)
        .filter_map(|index| {
            let worker_shared = Arc::clone(&shared);
            let worker_receiver = Arc::clone(&receiver);
            let worker_reactors = reactors.clone();
            match thread::Builder::new()
                .name(format!("rrs-direct-handshake-{index}"))
                .spawn(move || {
                    loop {
                        let job = match worker_receiver.lock() {
                            Ok(receiver) => match receiver.recv() {
                                Ok(job) => job,
                                Err(_) => return,
                            },
                            Err(_) => {
                                set_fatal(&worker_shared, "handshake-queue-lock");
                                return;
                            }
                        };
                        let serial = job.serial;
                        match super::session::accept(job.stream, serial, Arc::clone(&worker_shared))
                        {
                            Ok(session) => {
                                let reactor_index = usize::try_from(serial)
                                    .unwrap_or(0)
                                    .wrapping_rem(worker_reactors.len());
                                if let Err(error) = worker_reactors[reactor_index].submit(session) {
                                    remove_socket(&worker_shared, serial);
                                    session_failed(&worker_shared, &error);
                                }
                            }
                            Err(error) => {
                                remove_socket(&worker_shared, serial);
                                if !worker_shared.stop.load(Ordering::Acquire) {
                                    session_failed(&worker_shared, &error);
                                }
                            }
                        }
                    }
                }) {
                Ok(worker) => Some(worker),
                Err(error) => {
                    set_fatal(&shared, &format!("handshake-worker-spawn:{error}"));
                    None
                }
            }
        })
        .collect()
}

fn register_socket(
    shared: &SharedIngress,
    serial: u64,
    stream: &TcpStream,
) -> Result<(), super::super::RuntimeTransportError> {
    let clone = stream
        .try_clone()
        .map_err(|error| super::super::RuntimeTransportError::WebSocket(error.to_string()))?;
    shared
        .sockets
        .lock()
        .map_err(|_| super::super::RuntimeTransportError::Inbound("socket-lock".into()))?
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
