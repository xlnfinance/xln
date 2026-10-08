use hkdf::Hkdf;
use sha2::Sha256;

/// The same owner-bound key derivation is used at import and live HTLC admission.
pub(crate) fn derive_entity_encryption_key(
    seed: &str,
    entity_id: &str,
) -> Result<[u8; 32], String> {
    let payload = seed.strip_prefix("0x").ok_or("IMPORT_REPLICA_SEED")?;
    let seed_bytes = hex::decode(payload).map_err(|_| "IMPORT_REPLICA_SEED")?;
    if seed_bytes.len() != 64 {
        return Err("IMPORT_REPLICA_SEED".into());
    }
    let mut encryption = [0_u8; 32];
    Hkdf::<Sha256>::new(Some(entity_id.as_bytes()), &seed_bytes)
        .expand(b"xln:entity-encryption:v1", &mut encryption)
        .map_err(|_| "IMPORT_REPLICA_ENCRYPTION")?;
    Ok(encryption)
}
