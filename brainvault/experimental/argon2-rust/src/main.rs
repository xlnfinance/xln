use argon2_rust::{
    Algorithm, Argon2, Params, Version,
    params::{Memory, TagLen},
};
use std::io::{self, Read, Write};
use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};
use std::thread;

const INPUT_MAGIC: u32 = 0x3243_5642;
const HEADER_BYTES: usize = 24;
const SALT_BYTES: usize = 32;
const OUTPUT_BYTES: usize = 32;

fn read_u32le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("four-byte header field"))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input)?;
    if input.len() < HEADER_BYTES || read_u32le(&input[0..4]) != INPUT_MAGIC {
        return Err("invalid BrainVault native input".into());
    }
    let shard_count = read_u32le(&input[4..8]) as usize;
    let worker_count = read_u32le(&input[8..12]) as usize;
    let password_len = read_u32le(&input[12..16]) as usize;
    let memory_kib = read_u32le(&input[20..24]) as u64;
    let expected = HEADER_BYTES
        .checked_add(password_len)
        .and_then(|value| value.checked_add(shard_count.checked_mul(SALT_BYTES)?))
        .ok_or("input size overflow")?;
    if shard_count == 0
        || worker_count == 0
        || worker_count > 32
        || password_len == 0
        || memory_kib < 8
        || input.len() != expected
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
        Err(error) => {
            input.fill(0);
            return Err(error.into());
        }
    };
    let password = Arc::new(input[HEADER_BYTES..HEADER_BYTES + password_len].to_vec());
    let salts = Arc::new(input[HEADER_BYTES + password_len..].to_vec());
    input.fill(0);
    let next = Arc::new(AtomicU32::new(0));

    let mut handles = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let password = Arc::clone(&password);
        let salts = Arc::clone(&salts);
        let next = Arc::clone(&next);
        let params = params.clone();
        handles.push(thread::spawn(
            move || -> Result<Vec<(usize, [u8; OUTPUT_BYTES])>, argon2_rust::Error> {
                let mut hasher = Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hasher();
                let mut completed = Vec::new();
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed) as usize;
                    if index >= shard_count {
                        break;
                    }
                    let mut output = [0u8; OUTPUT_BYTES];
                    let salt_offset = index * SALT_BYTES;
                    hasher.hash_into(
                        &password,
                        &salts[salt_offset..salt_offset + SALT_BYTES],
                        &mut output,
                    )?;
                    completed.push((index, output));
                }
                Ok(completed)
            },
        ));
    }

    let mut outputs = vec![[0u8; OUTPUT_BYTES]; shard_count];
    let mut worker_error: Option<String> = None;
    for handle in handles {
        match handle.join() {
            Ok(Ok(completed)) => {
                for (index, output) in completed {
                    outputs[index] = output;
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
    let mut password = Arc::try_unwrap(password).map_err(|_| "native password still shared")?;
    let mut salts = Arc::try_unwrap(salts).map_err(|_| "native salts still shared")?;
    password.fill(0);
    salts.fill(0);
    if let Some(error) = worker_error {
        outputs.fill([0u8; OUTPUT_BYTES]);
        return Err(error.into());
    }
    let mut stdout = io::stdout().lock();
    let write_result = (|| -> io::Result<()> {
        for output in &outputs {
            stdout.write_all(output)?;
        }
        stdout.flush()
    })();
    outputs.fill([0u8; OUTPUT_BYTES]);
    write_result?;
    Ok(())
}
