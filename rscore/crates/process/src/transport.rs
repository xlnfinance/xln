use std::io::{Read, Write};

use xln_rscore_abi::{decode_envelope, encode_envelope};

use crate::{ProcessError, ProcessSession};

const MAX_FRAME_BYTES: usize = 1000 * 1024 * 1024;
const BODY_ARITY: usize = 1;

pub fn serve(reader: &mut impl Read, writer: &mut impl Write) -> Result<(), ProcessError> {
    let mut session = ProcessSession::new();
    loop {
        let frame = read_frame(reader)?.ok_or(ProcessError::EofBeforeShutdown)?;
        let request = decode_envelope(&frame, BODY_ARITY)?;
        let reply = session.handle(request);
        write_frame(writer, &encode_envelope(&reply.envelope)?)?;
        writer.flush()?;
        if reply.shutdown {
            return Ok(());
        }
    }
}

pub fn read_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, ProcessError> {
    let mut header = [0_u8; 4];
    match reader.read(&mut header[..1])? {
        0 => return Ok(None),
        1 => {}
        _ => return Err(ProcessError::TruncatedFrame),
    }
    read_frame_exact(reader, &mut header[1..])?;
    let length =
        usize::try_from(u32::from_be_bytes(header)).map_err(|_| ProcessError::FrameTooLarge {
            actual: usize::MAX,
            maximum: MAX_FRAME_BYTES,
        })?;
    if length == 0 {
        return Err(ProcessError::EmptyFrame);
    }
    if length > MAX_FRAME_BYTES {
        return Err(ProcessError::FrameTooLarge {
            actual: length,
            maximum: MAX_FRAME_BYTES,
        });
    }
    // A declared length is a claim. Grow into it as the bytes actually
    // arrive, so a stalled or lying writer cannot pin the whole ceiling on a
    // four-byte header.
    const CHUNK_BYTES: usize = 4 * 1024 * 1024;
    let mut frame = Vec::with_capacity(length.min(CHUNK_BYTES));
    while frame.len() < length {
        let want = CHUNK_BYTES.min(length - frame.len());
        let filled = frame.len();
        frame.resize(filled + want, 0);
        read_frame_exact(reader, &mut frame[filled..])?;
    }
    Ok(Some(frame))
}

fn read_frame_exact(reader: &mut impl Read, bytes: &mut [u8]) -> Result<(), ProcessError> {
    match reader.read_exact(bytes) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            Err(ProcessError::TruncatedFrame)
        }
        Err(error) => Err(error.into()),
    }
}

pub fn write_frame(writer: &mut impl Write, frame: &[u8]) -> Result<(), ProcessError> {
    if frame.is_empty() {
        return Err(ProcessError::EmptyFrame);
    }
    if frame.len() > MAX_FRAME_BYTES {
        return Err(ProcessError::FrameTooLarge {
            actual: frame.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }
    let length = u32::try_from(frame.len()).map_err(|_| ProcessError::FrameTooLarge {
        actual: frame.len(),
        maximum: MAX_FRAME_BYTES,
    })?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(frame)?;
    Ok(())
}
