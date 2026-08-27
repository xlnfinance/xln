use thiserror::Error;

#[derive(Debug, Error)]
pub enum RuntimeTransportError {
    #[error("RRS_TRANSPORT_CONFIG:{0}")]
    Config(&'static str),
    #[error("RRS_TRANSPORT_ROUTE:{0}")]
    Route(String),
    #[error("RRS_TRANSPORT_OUTBOX:{0}")]
    Outbox(String),
    #[error("RRS_TRANSPORT_QUEUE:rows={rows}:bytes={bytes}")]
    Queue { rows: usize, bytes: usize },
    #[error("RRS_TRANSPORT_MESSAGE_BYTES:{0}")]
    MessageBytes(usize),
    #[error("RRS_TRANSPORT_MSGPACK:{0}")]
    MessagePack(String),
    #[error("RRS_TRANSPORT_CRYPTO:{0}")]
    Crypto(&'static str),
    #[error("RRS_TRANSPORT_WEBSOCKET:{0}")]
    WebSocket(String),
    #[error("RRS_TRANSPORT_HANDSHAKE:{0}")]
    Handshake(String),
    #[error("RRS_TRANSPORT_RECONNECT_EXHAUSTED:target={target}:attempts={attempts}:last={last}")]
    ReconnectExhausted {
        target: String,
        attempts: usize,
        last: String,
    },
    #[error("RRS_TRANSPORT_PENDING_FRAME:pending={pending}:requested={requested}")]
    PendingFrame { pending: u64, requested: u64 },
    #[error("RRS_TRANSPORT_STORAGE:{0}")]
    Storage(#[from] crate::storage::native::NativeStorageError),
}
