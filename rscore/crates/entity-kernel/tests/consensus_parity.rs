mod support;

use xln_rscore_entity_kernel::{
    EntityConsensusSection, compute_entity_consensus_root, compute_entity_section_digest,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

fn canonical_sections(fixture: &serde_json::Value, case: &str) -> Vec<EntityConsensusSection> {
    fixture[case]["canonicalEntity"]["sections"]
        .as_array()
        .expect("canonical Entity sections")
        .iter()
        .map(|row| EntityConsensusSection {
            field: row["field"].as_str().expect("section field").to_string(),
            digest: row["digest"].as_str().expect("section digest").to_string(),
        })
        .collect()
}

#[test]
fn canonical_entity_roots_match_typescript_paybook_and_orderbook_states() {
    let fixture = support::fixture();
    for case in ["paybookForward", "sameJFullMatch"] {
        let expected = support::fixture_text(&fixture, &[case, "canonicalEntity", "root"]);
        assert_eq!(
            compute_entity_consensus_root(&canonical_sections(&fixture, case))
                .expect("canonical Entity root"),
            expected,
            "{case}"
        );
    }
}

#[test]
fn canonical_scalar_section_digest_matches_typescript() {
    let fixture = support::fixture();
    let expected = fixture["sameJFullMatch"]["canonicalEntity"]["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .find(|row| row["field"] == "height")
        .and_then(|row| row["digest"].as_str())
        .expect("height digest");
    let zero = CanonicalValue::Number(CanonicalNumber::from_u32(0));
    assert_eq!(
        compute_entity_section_digest(&zero).expect("section digest"),
        expected
    );
}
