use rayon::prelude::*;
use secp256k1::ecdsa::{RecoverableSignature, RecoveryId};
use secp256k1::{Message, PublicKey, SECP256K1, SecretKey};
use sha2::{Digest, Sha256};
use std::env;
use std::hint::black_box;
use std::time::{Duration, Instant};

const INPUT_WIRE_BYTES: usize = 32 + 8 + 8 + 8 + 8 + 32 + 33 + 1 + 64;
const OUTPUT_WIRE_BYTES: usize = 8 + 32 + 8 + 8 + 8 + 32;

#[derive(Clone)]
struct AccountInput {
    index: u64,
    account_id: [u8; 32],
    nonce: u64,
    balance: i64,
    delta: i64,
    previous_leaf: [u8; 32],
    expected_public_key: [u8; 33],
    recovery_id: u8,
    signature: [u8; 64],
}

#[derive(Clone)]
struct AccountEvent {
    index: u64,
    account_id: [u8; 32],
    nonce: u64,
    balance: i64,
    delta: i64,
    leaf: [u8; 32],
}

#[derive(Clone, Copy)]
struct Config {
    inputs: usize,
    iterations: usize,
    warmups: usize,
}

#[derive(Clone, Copy)]
enum Execution {
    Sequential,
    AllCores,
}

impl Execution {
    fn label(self) -> &'static str {
        match self {
            Self::Sequential => "1-thread",
            Self::AllCores => "all-cores",
        }
    }
}

fn parse_positive(name: &str, value: Option<String>) -> usize {
    let raw = value.unwrap_or_else(|| panic!("{name} requires a value"));
    let parsed = raw
        .parse::<usize>()
        .unwrap_or_else(|_| panic!("{name} must be a positive integer, got {raw}"));
    assert!(parsed > 0, "{name} must be greater than zero");
    parsed
}

fn parse_config() -> Config {
    let mut config = Config {
        inputs: 10_000,
        iterations: 3,
        warmups: 1,
    };
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--n" | "--inputs" => config.inputs = parse_positive(&arg, args.next()),
            "--iters" => config.iterations = parse_positive(&arg, args.next()),
            "--warmups" => config.warmups = parse_positive(&arg, args.next()),
            "--help" | "-h" => {
                println!("Usage: xln-native-account-bench [--n 10000] [--iters 3] [--warmups 1]");
                std::process::exit(0);
            }
            _ => panic!("unknown argument: {arg}"),
        }
    }
    config
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn signing_digest(input: &AccountInput) -> [u8; 32] {
    sha256(&[
        b"xln-account-input-v1",
        &input.account_id,
        &input.nonce.to_be_bytes(),
        &input.balance.to_be_bytes(),
        &input.delta.to_be_bytes(),
        &input.previous_leaf,
    ])
}

fn fixture_secret(index: u64) -> SecretKey {
    let candidate = sha256(&[b"xln-native-account-bench-key", &index.to_be_bytes()]);
    SecretKey::from_byte_array(candidate).expect("deterministic fixture key must be valid")
}

fn build_fixture(index: usize) -> AccountInput {
    let index = index as u64;
    let account_id = sha256(&[b"xln-native-account-id", &index.to_be_bytes()]);
    let previous_leaf = sha256(&[b"xln-native-account-leaf", &index.to_be_bytes()]);
    let balance = 1_000_000 + index as i64;
    let delta = (index % 11) as i64 - 5;
    let secret = fixture_secret(index);
    let public = PublicKey::from_secret_key(SECP256K1, &secret).serialize();
    let unsigned = AccountInput {
        index,
        account_id,
        nonce: index + 1,
        balance,
        delta,
        previous_leaf,
        expected_public_key: public,
        recovery_id: 0,
        signature: [0; 64],
    };
    let signature =
        SECP256K1.sign_ecdsa_recoverable(Message::from_digest(signing_digest(&unsigned)), &secret);
    let (recovery_id, signature) = signature.serialize_compact();
    AccountInput {
        recovery_id: i32::from(recovery_id) as u8,
        signature,
        ..unsigned
    }
}

fn apply_account_kernel(input: &AccountInput) -> AccountEvent {
    let digest = signing_digest(input);
    let message = Message::from_digest(digest);
    let recovery_id =
        RecoveryId::try_from(input.recovery_id as i32).expect("fixture recovery id must be valid");
    let recoverable = RecoverableSignature::from_compact(&input.signature, recovery_id)
        .expect("fixture signature must be compact secp256k1");
    let expected_public_key = PublicKey::from_slice(&input.expected_public_key)
        .expect("fixture public key must be compressed secp256k1");
    let recovered = SECP256K1
        .recover_ecdsa(message, &recoverable)
        .expect("fixture signature recovery must succeed");
    assert_eq!(recovered, expected_public_key, "recovered signer mismatch");
    SECP256K1
        .verify_ecdsa(message, &recoverable.to_standard(), &expected_public_key)
        .expect("fixture signature verification must succeed");

    let balance = input
        .balance
        .checked_add(input.delta)
        .expect("fixture signed delta must not overflow");
    let nonce = input.nonce + 1;
    let leaf = sha256(&[
        b"xln-account-leaf-v1",
        &input.account_id,
        &nonce.to_be_bytes(),
        &balance.to_be_bytes(),
        &input.previous_leaf,
        &digest,
    ]);
    AccountEvent {
        index: input.index,
        account_id: input.account_id,
        nonce,
        balance,
        delta: input.delta,
        leaf,
    }
}

fn encode_input(input: &AccountInput) -> [u8; INPUT_WIRE_BYTES] {
    let mut out = [0_u8; INPUT_WIRE_BYTES];
    let mut cursor = 0;
    macro_rules! put {
        ($bytes:expr) => {{
            let bytes = $bytes;
            out[cursor..cursor + bytes.len()].copy_from_slice(bytes);
            cursor += bytes.len();
        }};
    }
    put!(&input.account_id);
    put!(&input.index.to_be_bytes());
    put!(&input.nonce.to_be_bytes());
    put!(&input.balance.to_be_bytes());
    put!(&input.delta.to_be_bytes());
    put!(&input.previous_leaf);
    put!(&input.expected_public_key);
    put!(&[input.recovery_id]);
    put!(&input.signature);
    debug_assert_eq!(cursor, INPUT_WIRE_BYTES);
    out
}

fn take<const N: usize>(bytes: &[u8], cursor: &mut usize) -> [u8; N] {
    let result: [u8; N] = bytes[*cursor..*cursor + N]
        .try_into()
        .expect("fixed-width benchmark record truncated");
    *cursor += N;
    result
}

fn decode_input(bytes: &[u8]) -> AccountInput {
    assert_eq!(bytes.len(), INPUT_WIRE_BYTES);
    let mut cursor = 0;
    let account_id = take(bytes, &mut cursor);
    let index = u64::from_be_bytes(take(bytes, &mut cursor));
    let nonce = u64::from_be_bytes(take(bytes, &mut cursor));
    let balance = i64::from_be_bytes(take(bytes, &mut cursor));
    let delta = i64::from_be_bytes(take(bytes, &mut cursor));
    let previous_leaf = take(bytes, &mut cursor);
    let expected_public_key = take(bytes, &mut cursor);
    let recovery_id = take::<1>(bytes, &mut cursor)[0];
    let signature = take(bytes, &mut cursor);
    debug_assert_eq!(cursor, INPUT_WIRE_BYTES);
    AccountInput {
        index,
        account_id,
        nonce,
        balance,
        delta,
        previous_leaf,
        expected_public_key,
        recovery_id,
        signature,
    }
}

fn encode_event(event: &AccountEvent) -> [u8; OUTPUT_WIRE_BYTES] {
    let mut out = [0_u8; OUTPUT_WIRE_BYTES];
    let mut cursor = 0;
    for bytes in [
        event.index.to_be_bytes().as_slice(),
        event.account_id.as_slice(),
        event.nonce.to_be_bytes().as_slice(),
        event.balance.to_be_bytes().as_slice(),
        event.delta.to_be_bytes().as_slice(),
        event.leaf.as_slice(),
    ] {
        out[cursor..cursor + bytes.len()].copy_from_slice(bytes);
        cursor += bytes.len();
    }
    debug_assert_eq!(cursor, OUTPUT_WIRE_BYTES);
    out
}

fn decode_event(bytes: &[u8]) -> AccountEvent {
    assert_eq!(bytes.len(), OUTPUT_WIRE_BYTES);
    let mut cursor = 0;
    let index = u64::from_be_bytes(take(bytes, &mut cursor));
    let account_id = take(bytes, &mut cursor);
    let nonce = u64::from_be_bytes(take(bytes, &mut cursor));
    let balance = i64::from_be_bytes(take(bytes, &mut cursor));
    let delta = i64::from_be_bytes(take(bytes, &mut cursor));
    let leaf = take(bytes, &mut cursor);
    debug_assert_eq!(cursor, OUTPUT_WIRE_BYTES);
    AccountEvent {
        index,
        account_id,
        nonce,
        balance,
        delta,
        leaf,
    }
}

fn process_with_boundary(input: &AccountInput) -> AccountEvent {
    let encoded_input = encode_input(input);
    let ffi_input_copy = encoded_input.to_vec();
    let owned_input = decode_input(&ffi_input_copy);
    let event = apply_account_kernel(&owned_input);
    let encoded_output = encode_event(&event);
    let ffi_output_copy = encoded_output.to_vec();
    decode_event(&ffi_output_copy)
}

fn run_batch(
    fixtures: &[AccountInput],
    execution: Execution,
    include_boundary: bool,
) -> Vec<AccountEvent> {
    match execution {
        Execution::Sequential => fixtures
            .iter()
            .map(|input| {
                if include_boundary {
                    process_with_boundary(input)
                } else {
                    apply_account_kernel(input)
                }
            })
            .collect(),
        Execution::AllCores => fixtures
            .par_iter()
            .map(|input| {
                if include_boundary {
                    process_with_boundary(input)
                } else {
                    apply_account_kernel(input)
                }
            })
            .collect(),
    }
}

fn validate_events(fixtures: &[AccountInput], events: &[AccountEvent]) -> u64 {
    assert_eq!(fixtures.len(), events.len(), "event count mismatch");
    let mut checksum = 0_u64;
    for (position, (input, event)) in fixtures.iter().zip(events).enumerate() {
        assert_eq!(
            event.index as usize, position,
            "events must retain input order"
        );
        assert_eq!(event.account_id, input.account_id, "event account mismatch");
        assert_eq!(event.nonce, input.nonce + 1, "event nonce mismatch");
        assert_eq!(
            event.balance,
            input.balance + input.delta,
            "event balance mismatch"
        );
        assert_eq!(event.delta, input.delta, "event delta mismatch");
        checksum =
            checksum.rotate_left(7) ^ u64::from_be_bytes(event.leaf[..8].try_into().unwrap());
    }
    checksum
}

fn median(values: &mut [Duration]) -> Duration {
    values.sort_unstable();
    values[values.len() / 2]
}

fn benchmark_case(
    fixtures: &[AccountInput],
    config: Config,
    execution: Execution,
    include_boundary: bool,
) {
    for _ in 0..config.warmups {
        let events = run_batch(fixtures, execution, include_boundary);
        black_box(validate_events(fixtures, &events));
    }

    let mut samples = Vec::with_capacity(config.iterations);
    let mut final_checksum = 0_u64;
    for _ in 0..config.iterations {
        let started = Instant::now();
        let events = run_batch(fixtures, execution, include_boundary);
        let elapsed = started.elapsed();
        final_checksum ^= validate_events(fixtures, &events);
        samples.push(elapsed);
    }
    black_box(final_checksum);

    let min = *samples.iter().min().unwrap();
    let max = *samples.iter().max().unwrap();
    let med = median(&mut samples);
    let tps = config.inputs as f64 / med.as_secs_f64();
    let boundary = if include_boundary {
        "included"
    } else {
        "excluded"
    };
    println!(
        "RESULT execution={} serialization_copy={} n={} median_ms={:.3} min_ms={:.3} max_ms={:.3} inputs_per_s={:.2} checksum=0x{:016x}",
        execution.label(),
        boundary,
        config.inputs,
        med.as_secs_f64() * 1_000.0,
        min.as_secs_f64() * 1_000.0,
        max.as_secs_f64() * 1_000.0,
        tps,
        final_checksum,
    );
}

fn main() {
    let config = parse_config();
    let logical_cores = std::thread::available_parallelism().map_or(1, usize::from);
    println!(
        "CONFIG n={} iterations={} warmups={} logical_cores={} rayon_threads={} input_wire_bytes={} output_wire_bytes={} crypto=secp256k1_recover_plus_verify hashes=sha256x2",
        config.inputs,
        config.iterations,
        config.warmups,
        logical_cores,
        rayon::current_num_threads(),
        INPUT_WIRE_BYTES,
        OUTPUT_WIRE_BYTES,
    );
    println!(
        "NOTE fixture key generation and signing are outside timed regions; ordered result collection is inside"
    );
    let fixtures: Vec<AccountInput> = (0..config.inputs).map(build_fixture).collect();
    benchmark_case(&fixtures, config, Execution::Sequential, false);
    benchmark_case(&fixtures, config, Execution::Sequential, true);
    benchmark_case(&fixtures, config, Execution::AllCores, false);
    benchmark_case(&fixtures, config, Execution::AllCores, true);
}
