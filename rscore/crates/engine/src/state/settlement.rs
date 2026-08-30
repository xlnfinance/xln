use xln_rscore_protocol::CanonicalValue;

use crate::StateError;

/// Exact `settlementWorkspaceWithoutHankos` projection. Hanko encodings are
/// valid non-unique threshold witnesses, so the bilateral Account root binds
/// their signed targets and all workspace state but not the witness subset.
pub(crate) fn without_hankos(
    workspace: Option<&CanonicalValue>,
) -> Result<Option<CanonicalValue>, StateError> {
    let Some(CanonicalValue::Object(fields)) = workspace else {
        return match workspace {
            None => Ok(None),
            Some(_) => Err(StateError::AccountStateRoot(
                "SETTLEMENT_WORKSPACE_OBJECT_REQUIRED".into(),
            )),
        };
    };
    let mut projected = Vec::with_capacity(fields.len());
    for (key, value) in fields {
        if key == "leftHanko" || key == "rightHanko" {
            continue;
        }
        if key == "postSettlementDisputeProof" {
            let CanonicalValue::Object(proof) = value else {
                return Err(StateError::AccountStateRoot(
                    "SETTLEMENT_POST_PROOF_OBJECT_REQUIRED".into(),
                ));
            };
            projected.push((
                key.clone(),
                CanonicalValue::Object(
                    proof
                        .iter()
                        .filter(|(field, _)| field != "leftHanko" && field != "rightHanko")
                        .cloned()
                        .collect(),
                ),
            ));
        } else {
            projected.push((key.clone(), value.clone()));
        }
    }
    Ok(Some(CanonicalValue::Object(projected)))
}
