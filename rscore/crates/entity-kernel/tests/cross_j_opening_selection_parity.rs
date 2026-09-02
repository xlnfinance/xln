use num_bigint::BigInt;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use xln_rscore_engine::{AccountFrame, AccountTx, canonical_tx_digest, parse_root_hex};
use xln_rscore_entity_kernel::{
    CrossJOpeningProposalSelection, CrossJOpeningSiblingAccountView,
    CrossJOpeningSiblingEntityView, select_cross_j_opening_proposal,
};
use xln_rscore_protocol::{CanonicalNumber, CanonicalValue};

const SOURCE_USER: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const SOURCE_HUB: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const TARGET_HUB: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";
const TARGET_USER: &str = "0x4444444444444444444444444444444444444444444444444444444444444444";
const SOURCE_USER_SIGNER: &str = "0x5151515151515151515151515151515151515151";
const SOURCE_HUB_SIGNER: &str = "0x5252525252525252525252525252525252525252";
const TARGET_HUB_SIGNER: &str = "0x5353535353535353535353535353535353535353";
const TARGET_USER_SIGNER: &str = "0x5454545454545454545454545454545454545454";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    version: u64,
    canonical_source: String,
    frame: FrameVector,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameVector {
    height: u64,
    timestamp: u64,
    j_height: u64,
    prev_frame_hash: String,
    account_state_root: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    local_role: String,
    local_mempool: Vec<String>,
    sibling_mempool: Vec<String>,
    sibling_pending: Option<Vec<String>>,
    expected: Expected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    kind: String,
    selected: Vec<String>,
    selected_tx_digests: Vec<String>,
    frame_hash: Option<String>,
}

struct Role<'a> {
    entity_id: &'a str,
    signer_id: &'a str,
    account_id: &'a str,
    sibling_role: &'a str,
}

fn role(name: &str) -> Role<'static> {
    match name {
        "source-user" => Role {
            entity_id: SOURCE_USER,
            signer_id: SOURCE_USER_SIGNER,
            account_id: SOURCE_HUB,
            sibling_role: "target-user",
        },
        "source-hub" => Role {
            entity_id: SOURCE_HUB,
            signer_id: SOURCE_HUB_SIGNER,
            account_id: SOURCE_USER,
            sibling_role: "target-hub",
        },
        "target-hub" => Role {
            entity_id: TARGET_HUB,
            signer_id: TARGET_HUB_SIGNER,
            account_id: TARGET_USER,
            sibling_role: "source-hub",
        },
        "target-user" => Role {
            entity_id: TARGET_USER,
            signer_id: TARGET_USER_SIGNER,
            account_id: TARGET_HUB,
            sibling_role: "source-user",
        },
        other => panic!("unknown role {other}"),
    }
}

fn object(entries: impl IntoIterator<Item = (&'static str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_string(), value))
            .collect(),
    )
}

fn string(value: &str) -> CanonicalValue {
    CanonicalValue::String(value.to_string())
}

fn number(value: u64) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("safe fixture number"))
}

fn repeated_hash(label: &str) -> String {
    let byte = Sha256::digest(label.as_bytes())[0];
    format!("0x{}", format!("{byte:02x}").repeat(32))
}

fn route(order_id: &str) -> CanonicalValue {
    object([
        ("orderId", string(order_id)),
        (
            "routeHash",
            string(&repeated_hash(&format!("route:{order_id}"))),
        ),
        ("makerEntityId", string(SOURCE_USER)),
        ("hubEntityId", string(SOURCE_HUB)),
        ("sourceSignerId", string(SOURCE_USER_SIGNER)),
        ("sourceHubSignerId", string(SOURCE_HUB_SIGNER)),
        ("targetHubSignerId", string(TARGET_HUB_SIGNER)),
        ("targetSignerId", string(TARGET_USER_SIGNER)),
        (
            "sourceDisputeConfig",
            object([
                ("leftResponseSeconds", number(10)),
                ("rightResponseSeconds", number(10)),
            ]),
        ),
        (
            "targetDisputeConfig",
            object([
                ("leftResponseSeconds", number(10)),
                ("rightResponseSeconds", number(10)),
            ]),
        ),
        (
            "source",
            object([
                (
                    "jurisdiction",
                    string(&format!("stack:1:0x{}", "61".repeat(20))),
                ),
                ("entityId", string(SOURCE_USER)),
                ("counterpartyEntityId", string(SOURCE_HUB)),
                ("tokenId", number(1)),
                ("amount", CanonicalValue::BigInt(BigInt::from(10))),
            ]),
        ),
        (
            "target",
            object([
                (
                    "jurisdiction",
                    string(&format!("stack:2:0x{}", "62".repeat(20))),
                ),
                ("entityId", string(TARGET_HUB)),
                ("counterpartyEntityId", string(TARGET_USER)),
                ("tokenId", number(2)),
                ("amount", CanonicalValue::BigInt(BigInt::from(20))),
            ]),
        ),
        ("status", string("intent")),
        ("createdAt", number(1_000)),
        ("updatedAt", number(1_000)),
        ("expiresAt", number(61_000)),
    ])
}

fn tx(label: &str, role_name: &str) -> AccountTx {
    if label == "ordinary" {
        return AccountTx::SwapCancelRequest {
            offer_id: "ordinary".into(),
        };
    }
    let (kind, order_id) = label.split_once(':').expect("kind:order fixture label");
    let route = route(order_id);
    if kind == "offer" {
        return AccountTx::SwapOffer {
            offer_id: order_id.to_string(),
            give_token_id: 1,
            give_token_decimals: 6,
            give_amount: BigInt::from(10),
            want_token_id: 2,
            want_token_decimals: 6,
            want_amount: BigInt::from(20),
            max_fee: BigInt::from(0),
            min_net_receive: BigInt::from(20),
            time_in_force: Some(0),
            price_ticks: None,
            cross_jurisdiction: Some(route),
        };
    }
    assert_eq!(kind, "pull", "fixture transaction kind");
    let source = matches!(role_name, "source-user" | "source-hub");
    let leg = if source { "source" } else { "target" };
    AccountTx::CrossPullLock {
        data: object([
            ("pullId", string(&format!("{order_id}-{leg}"))),
            ("tokenId", number(if source { 1 } else { 2 })),
            (
                "amount",
                CanonicalValue::BigInt(BigInt::from(if source { -10 } else { -20 })),
            ),
            (
                "fullHash",
                string(&repeated_hash(&format!("full:{order_id}"))),
            ),
            (
                "partialRoot",
                string(&repeated_hash(&format!("partial:{order_id}"))),
            ),
            (
                "crossJurisdiction",
                object([
                    ("orderId", string(order_id)),
                    (
                        "routeHash",
                        string(&repeated_hash(&format!("route:{order_id}"))),
                    ),
                    ("leg", string(leg)),
                ]),
            ),
            ("crossJurisdictionRoute", route),
        ]),
    }
}

fn label(tx: &AccountTx) -> String {
    let data = match tx {
        AccountTx::CrossPullLock { data } => data,
        AccountTx::SwapOffer {
            cross_jurisdiction: Some(data),
            ..
        } => return format!("offer:{}", text(data, "orderId")),
        _ => return "ordinary".into(),
    };
    let binding = field(data, "crossJurisdiction");
    format!("pull:{}", text(binding, "orderId"))
}

fn field<'a>(value: &'a CanonicalValue, name: &str) -> &'a CanonicalValue {
    let CanonicalValue::Object(fields) = value else {
        panic!("fixture object")
    };
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
        .unwrap_or_else(|| panic!("fixture field {name}"))
}

fn text<'a>(value: &'a CanonicalValue, name: &str) -> &'a str {
    let CanonicalValue::String(value) = field(value, name) else {
        panic!("fixture text {name}")
    };
    value
}

fn digest(tx: &AccountTx) -> String {
    format!(
        "0x{}",
        hex::encode(canonical_tx_digest(tx).expect("canonical transaction digest"))
    )
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/cross-j-opening/parity-v1.json"
    )))
    .expect("TypeScript cross-J opening fixture")
}

#[test]
fn rust_selector_matches_every_typescript_cross_j_opening_vector() {
    let fixture = fixture();
    assert_eq!(fixture.version, 1);
    assert_eq!(
        fixture.canonical_source,
        "TypeScript selectCrossJOpeningAccountProposalTxs"
    );
    assert_eq!(fixture.cases.len(), 7);

    for case in fixture.cases {
        let local = role(&case.local_role);
        let sibling = role(local.sibling_role);
        let local_txs = case
            .local_mempool
            .iter()
            .map(|label| tx(label, &case.local_role))
            .collect::<Vec<_>>();
        let sibling_txs = case
            .sibling_mempool
            .iter()
            .map(|label| tx(label, local.sibling_role))
            .collect::<Vec<_>>();
        let pending = case.sibling_pending.as_ref().map(|labels| {
            labels
                .iter()
                .map(|label| tx(label, local.sibling_role))
                .collect::<Vec<_>>()
        });
        let siblings = [CrossJOpeningSiblingEntityView {
            entity_id: sibling.entity_id.to_string(),
            signer_id: sibling.signer_id.to_string(),
            accounts: vec![CrossJOpeningSiblingAccountView {
                counterparty_entity_id: sibling.account_id.to_string(),
                mempool: sibling_txs,
                pending_frame_txs: pending,
            }],
        }];
        let selection = select_cross_j_opening_proposal(
            local.entity_id,
            local.account_id,
            &local_txs,
            &siblings,
        )
        .unwrap_or_else(|error| panic!("{}: {error}", case.name));
        let selected = match selection {
            CrossJOpeningProposalSelection::Ordinary => {
                assert_eq!(case.expected.kind, "ordinary", "{} kind", case.name);
                Vec::new()
            }
            CrossJOpeningProposalSelection::Wait => {
                assert_eq!(case.expected.kind, "wait", "{} kind", case.name);
                Vec::new()
            }
            CrossJOpeningProposalSelection::Selected(txs) => {
                assert_eq!(case.expected.kind, "selected", "{} kind", case.name);
                txs
            }
        };
        assert_eq!(
            selected.iter().map(label).collect::<Vec<_>>(),
            case.expected.selected,
            "{} selected order",
            case.name,
        );
        assert_eq!(
            selected.iter().map(digest).collect::<Vec<_>>(),
            case.expected.selected_tx_digests,
            "{} selected transaction digests",
            case.name,
        );
        if let Some(expected_hash) = case.expected.frame_hash {
            let frame = AccountFrame {
                height: fixture.frame.height,
                timestamp: fixture.frame.timestamp,
                j_height: fixture.frame.j_height,
                txs: selected,
                prev_frame_hash: fixture.frame.prev_frame_hash.clone(),
                account_state_root: parse_root_hex(&fixture.frame.account_state_root)
                    .expect("fixture Account root"),
            };
            assert_eq!(
                format!(
                    "0x{}",
                    hex::encode(frame.hash().expect("Account frame hash"))
                ),
                expected_hash,
                "{} literal frame hash",
                case.name,
            );
        }
    }
}
