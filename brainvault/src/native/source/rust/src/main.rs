use argon2_rust::{
    Algorithm, Argon2, Params, Version,
    params::{Memory, TagLen},
};
use std::io::{self, Read, Write};
use std::ops::{Deref, DerefMut};
use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering, compiler_fence},
};
use std::thread;

const INPUT_MAGIC: u32 = 0x3243_5642;
const HEADER_BYTES: usize = 24;
const SALT_BYTES: usize = 32;
const OUTPUT_BYTES: usize = 32;

fn secure_zero(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

struct SecretVec(Vec<u8>);

impl Deref for SecretVec {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for SecretVec {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for SecretVec {
    fn drop(&mut self) {
        secure_zero(&mut self.0);
    }
}

struct SecretOutput([u8; OUTPUT_BYTES]);

impl Drop for SecretOutput {
    fn drop(&mut self) {
        secure_zero(&mut self.0);
    }
}

fn read_u32le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("four-byte header field"))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args_os().count() != 1 {
        return Err("invalid BrainVault native invocation".into());
    }
    let mut stdin = io::stdin().lock();
    let mut header = [0u8; HEADER_BYTES];
    stdin.read_exact(&mut header)?;
    if read_u32le(&header[0..4]) != INPUT_MAGIC {
        return Err("invalid BrainVault native input".into());
    }
    let shard_count = read_u32le(&header[4..8]) as usize;
    let worker_count = read_u32le(&header[8..12]) as usize;
    let password_len = read_u32le(&header[12..16]) as usize;
    let flags = read_u32le(&header[16..20]);
    let memory_kib = read_u32le(&header[20..24]) as u64;
    let salt_len = shard_count.checked_mul(SALT_BYTES).ok_or("input size overflow")?;
    if shard_count == 0
        || worker_count == 0
        || worker_count > shard_count
        || worker_count > 32
        || password_len == 0
        || flags != 0
        || memory_kib < 8
    {
        return Err("invalid BrainVault native dimensions".into());
    }

    let params = match Params::builder()
        .memory(Memory::kib(memory_kib))
        .passes(1)
        .lanes(1)
        .threads(1)
        .tag_len(TagLen::bytes(OUTPUT_BYTES as u64))
        .build()
    {
        Ok(params) => params,
        Err(error) => return Err(error.into()),
    };
    let mut password = SecretVec(vec![0u8; password_len]);
    let mut salts = SecretVec(vec![0u8; salt_len]);
    stdin.read_exact(&mut password.0)?;
    stdin.read_exact(&mut salts.0)?;
    let mut trailing = SecretVec(vec![0u8; 1]);
    if stdin.read(&mut trailing.0)? != 0 {
        return Err("invalid BrainVault native input length".into());
    }
    drop(stdin);
    let password = Arc::new(password);
    let salts = Arc::new(salts);
    let next = Arc::new(AtomicU32::new(0));
    let progress = Arc::new(AtomicU32::new(0));
    let progress_enabled = std::env::var_os("BRAINVAULT_NATIVE_PROGRESS").is_some();
    let progress_step = std::cmp::max(1, shard_count / 500) as u32;

    let mut handles = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let password = Arc::clone(&password);
        let salts = Arc::clone(&salts);
        let next = Arc::clone(&next);
        let progress = Arc::clone(&progress);
        let params = params.clone();
        handles.push(thread::spawn(
            move || -> Result<Vec<(usize, SecretOutput)>, argon2_rust::Error> {
                let mut hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hasher();
                let mut completed = Vec::new();
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed) as usize;
                    if index >= shard_count {
                        break;
                    }
                    let mut output = SecretOutput([0u8; OUTPUT_BYTES]);
                    let salt_offset = index * SALT_BYTES;
                    hasher.hash_into(
                        &password,
                        &salts[salt_offset..salt_offset + SALT_BYTES],
                        &mut output.0,
                    )?;
                    let done = progress.fetch_add(1, Ordering::Relaxed) + 1;
                    if progress_enabled &&
                        (done as usize == shard_count || done % progress_step == 0) {
                        eprintln!("BVP1 {done}");
                    }
                    completed.push((index, output));
                }
                Ok(completed)
            },
        ));
    }

    let mut outputs: Vec<SecretOutput> = (0..shard_count)
        .map(|_| SecretOutput([0u8; OUTPUT_BYTES]))
        .collect();
    let mut worker_error: Option<String> = None;
    for handle in handles {
        match handle.join() {
            Ok(Ok(completed)) => {
                for (index, output) in completed {
                    outputs[index].0.copy_from_slice(&output.0);
                }
            }
            Ok(Err(error)) => {
                worker_error.get_or_insert_with(|| format!("native worker failed: {error}"));
            }
            Err(_) => {
                worker_error.get_or_insert_with(|| "native worker panicked".to_owned());
            }
        }
    }
    drop(password);
    drop(salts);
    if let Some(error) = worker_error {
        return Err(error.into());
    }
    let mut stdout = io::stdout().lock();
    let write_result = (|| -> io::Result<()> {
        for output in &outputs {
            stdout.write_all(&output.0)?;
        }
        stdout.flush()
    })();
    write_result?;
    Ok(())
}
