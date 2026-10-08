use super::*;
use serde_json::{Value, json};
#[test]
fn four_hop_exact_capacity_fee_inversion_and_funding_boundary() {
    let a = |v: u64| BigInt::from(v);
    let edges = vec![
        Edge {
            from: "s".into(),
            to: "h1".into(),
            capacity: a(25_000_075),
            base: a(0),
            ppm: 1,
        },
        Edge {
            from: "h1".into(),
            to: "h2".into(),
            capacity: a(25_000_050),
            base: a(0),
            ppm: 1,
        },
        Edge {
            from: "h2".into(),
            to: "h3".into(),
            capacity: a(25_000_025),
            base: a(0),
            ppm: 1,
        },
        Edge {
            from: "h3".into(),
            to: "t".into(),
            capacity: a(25_000_000),
            base: a(0),
            ppm: 1,
        },
    ];
    let routes = search(&edges, "s", "t", &a(25_000_000), None).unwrap();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].total, a(25_000_075));
    assert_eq!(routes[0].fees, vec![a(0), a(25), a(25), a(25)]);
    assert!(
        search(&edges, "s", "t", &a(25_000_001), None)
            .unwrap()
            .is_empty()
    );
    let mut changed = edges.clone();
    changed[0].capacity = a(0);
    assert!(
        search(&changed, "s", "t", &a(25_000_000), None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        search(&changed, "s", "t", &a(25_000_000), Some("h1"))
            .unwrap()
            .len(),
        1
    );
    changed[2].capacity -= 1;
    assert!(
        search(&changed, "s", "t", &a(25_000_000), Some("h1"))
            .unwrap()
            .is_empty()
    );
    assert!(
        search(&edges, "s", "t", &a(25_000_000), Some("h2"))
            .unwrap()
            .is_empty()
    );
}
#[test]
fn fee_order_stable_and_big_integer_precision() {
    let amount = BigInt::from(10u32).pow(30);
    let edge = |from: &str, to: &str, base: u32| Edge {
        from: from.into(),
        to: to.into(),
        capacity: &amount * 10,
        base: base.into(),
        ppm: 0,
    };
    let edges = vec![
        edge("s", "a", 0),
        edge("s", "b", 0),
        edge("s", "c", 0),
        edge("a", "t", 2),
        edge("b", "t", 1),
        edge("c", "t", 1),
    ];
    let routes = search(&edges, "s", "t", &amount, None).unwrap();
    assert_eq!(
        routes
            .iter()
            .map(|r| r.path[1].as_str())
            .collect::<Vec<_>>(),
        vec!["b", "c", "a"]
    );
    assert_eq!(routes[0].total, &amount + 1);
}
#[test]
fn captured_live_three_hub_profiles_match_typescript_quote() {
    let profiles: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../../core/__tests__/fixtures/pathfinding/three-hub-live-profiles.json"
    ))
    .unwrap();
    let ids: Vec<&str> = profiles
        .iter()
        .map(|p| p["entityId"].as_str().unwrap())
        .collect();
    let expected = vec![ids[0], ids[2], ids[3], ids[4], ids[1]];
    let edges = edges(&profiles, 1, ids[0], None).unwrap();
    let amount = BigInt::from(25_000_000);
    let routes = search(&edges, ids[0], ids[1], &amount, None).unwrap();
    let route = routes.iter().find(|r| r.path == expected).unwrap();
    assert_eq!(route.total, BigInt::from(25_000_075));
    assert_eq!(route.fees, vec![0.into(), 25.into(), 25.into(), 25.into()]);
    assert!(
        search(&edges, ids[0], ids[1], &(&amount + 1), None)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn mirrored_lane_uses_reverse_owners_fee_policy() {
    let profiles = vec![
        json!({"entityId":"a","metadata":{"routingFeePPM":1000,"baseFee":"7"},"accounts":[{"counterpartyId":"b","tokenCapacities":{"1":{"outCapacity":"900","inCapacity":"100"}}}]}),
        json!({"entityId":"b","metadata":{"routingFeePPM":2000,"baseFee":"11"},"accounts":[]}),
    ];
    let edges = edges(&profiles, 1, "a", None).unwrap();
    assert_eq!(edge(&edges, "a", "b").unwrap().ppm, 1100);
    assert_eq!(edge(&edges, "b", "a").unwrap().ppm, 3000);
    assert_eq!(edge(&edges, "b", "a").unwrap().base, BigInt::from(11));
}
