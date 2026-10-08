//! Proposed production bridge. Not linked until sole Rust owner integrates.
//! Secret inputs arrive only from the piped canonical Bun custody worker.
//! Canonical import intentionally stores the BIP39 entity seed in private WAL;
//! the signing private key stays process-local. Neither belongs in public RPC.
use serde_json::{Value, json};
use std::collections::BTreeMap;
use xln_rscore_crypto::address_of_private_key;
use xln_rscore_engine::{BoardDelays, SigningIdentity};

// Use both for pre-restore configuration key merge and live key installation.
// Never serialize this map, Debug-print it, or persist another key representation.
pub fn install_custody_key(
    keys: &mut BTreeMap<String, [u8; 32]>,
    signer: &str,
    private_key: [u8; 32],
) -> Result<(), String> {
    let address = address_of_private_key(&private_key).ok_or("BRAINVAULT_PRIVATE_KEY_INVALID")?;
    let expected = format!("0x{}", hex::encode(address));
    if signer != expected {
        return Err("BRAINVAULT_SIGNER_KEY_MISMATCH".into());
    }
    if let Some(existing) = keys.get(signer) {
        if existing != &private_key {
            return Err("BRAINVAULT_SIGNER_KEY_CONFLICT".into());
        }
        return Ok(());
    }
    keys.insert(signer.to_owned(), private_key);
    Ok(())
}

// jurisdiction is selected from the committed JReplica by the existing live
// canonical jurisdiction selector, never supplied by browser or custody worker.
// It has TS ConsensusConfig jurisdiction shape, including actual chain/address.
pub fn custody_owner_import(
    signer: &str,
    private_key: [u8; 32],
    entity_seed: &str,
    jurisdiction: Value,
    profile_name: &str,
) -> Result<([u8; 32], crate::entity_import::ImportReplica), String> {
    let mut checked = BTreeMap::new();
    install_custody_key(&mut checked, signer, private_key)?;
    let identity =
        SigningIdentity::lazy_from_key(private_key, signer, 1, 1, BoardDelays::default())
            .map_err(|_| "BRAINVAULT_SIGNER_IDENTITY_INVALID".to_owned())?;
    let entity_id = *identity.entity_id();
    let input = json!({"type":"importReplica", "entityId":format!("0x{}",hex::encode(entity_id)),
        "signerId":signer, "data":{"entitySeed":entity_seed,"isProposer":true,
        "profileName":profile_name, "config":{"mode":"proposer-based", "threshold":{"__xlnType":"BigInt","value":"1"},
        "validators":[signer], "shares":{signer:{"__xlnType":"BigInt","value":"1"}}, "jurisdiction":jurisdiction}}});
    // The existing decoder/reducer validate seed/config and committed-J binding.
    let decoded = crate::entity_import::decode(&input)?;
    Ok((entity_id, decoded))
}
