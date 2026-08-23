use rayon::prelude::*;
use secp256k1::ecdsa::{RecoverableSignature, RecoveryId};
use secp256k1::{Message, Secp256k1};
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

const RECOVER_RECORD_BYTES: usize = 97;

fn with_pool<T: Send>(threads: usize, work: impl FnOnce() -> T + Send) -> T {
    if threads <= 1 {
        return work();
    }
    static POOLS: OnceLock<Mutex<HashMap<usize, Arc<rayon::ThreadPool>>>> = OnceLock::new();
    let pools = POOLS.get_or_init(|| Mutex::new(HashMap::new()));
    let pool = {
        let mut guard = pools.lock().expect("pool map");
        guard.entry(threads).or_insert_with(|| Arc::new(
            rayon::ThreadPoolBuilder::new().num_threads(threads).build().expect("thread pool"),
        )).clone()
    };
    pool.install(work)
}

pub fn sha256_batch(input: &[u8], stride: usize, output: &mut [u8], threads: usize) -> i32 {
    if stride == 0 || input.len() % stride != 0 || output.len() != input.len() / stride * 32 {
        return -1;
    }
    if threads <= 1 {
        for (out, record) in output.chunks_mut(32).zip(input.chunks(stride)) {
            out.copy_from_slice(&Sha256::digest(record));
        }
    } else { with_pool(threads, || {
        output
            .par_chunks_mut(32)
            .zip(input.par_chunks(stride))
            .for_each(|(out, record)| out.copy_from_slice(&Sha256::digest(record)));
    }); }
    0
}

pub fn recover_batch(input: &[u8], output: &mut [u8], threads: usize) -> i32 {
    if input.len() % RECOVER_RECORD_BYTES != 0 || output.len() != input.len() / RECOVER_RECORD_BYTES * 20 {
        return -1;
    }
    let failed = std::sync::atomic::AtomicBool::new(false);
    let recover = |out: &mut [u8], record: &[u8]| {
        let message = Message::from_digest(record[..32].try_into().expect("digest size"));
        let Ok(recovery_id) = RecoveryId::try_from(i32::from(record[96])) else {
            failed.store(true, std::sync::atomic::Ordering::Relaxed);
            return;
        };
        let Ok(signature) = RecoverableSignature::from_compact(&record[32..96], recovery_id) else {
            failed.store(true, std::sync::atomic::Ordering::Relaxed);
            return;
        };
        let Ok(public_key) = Secp256k1::verification_only().recover_ecdsa(message, &signature) else {
            failed.store(true, std::sync::atomic::Ordering::Relaxed);
            return;
        };
        let digest = Keccak256::digest(&public_key.serialize_uncompressed()[1..]);
        out.copy_from_slice(&digest[12..]);
    };
    if threads <= 1 {
        for (out, record) in output.chunks_mut(20).zip(input.chunks(RECOVER_RECORD_BYTES)) {
            recover(out, record);
        }
    } else { with_pool(threads, || {
        output
            .par_chunks_mut(20)
            .zip(input.par_chunks(RECOVER_RECORD_BYTES))
            .for_each(|(out, record)| recover(out, record));
    }); }
    if failed.load(std::sync::atomic::Ordering::Relaxed) { -2 } else { 0 }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn xln_sha256_batch(
    input: *const u8,
    count: usize,
    stride: usize,
    output: *mut u8,
    threads: usize,
) -> i32 {
    if input.is_null() || output.is_null() { return -1; }
    let input = unsafe { std::slice::from_raw_parts(input, count.saturating_mul(stride)) };
    let output = unsafe { std::slice::from_raw_parts_mut(output, count.saturating_mul(32)) };
    sha256_batch(input, stride, output, threads)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn xln_recover_batch(
    input: *const u8,
    count: usize,
    output: *mut u8,
    threads: usize,
) -> i32 {
    if input.is_null() || output.is_null() { return -1; }
    let input = unsafe { std::slice::from_raw_parts(input, count.saturating_mul(RECOVER_RECORD_BYTES)) };
    let output = unsafe { std::slice::from_raw_parts_mut(output, count.saturating_mul(20)) };
    recover_batch(input, output, threads)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn xln_copy_batch(
    input: *const u8,
    length: usize,
    output: *mut u8,
) -> i32 {
    if input.is_null() || output.is_null() { return -1; }
    unsafe { std::ptr::copy_nonoverlapping(input, output, length) };
    0
}
