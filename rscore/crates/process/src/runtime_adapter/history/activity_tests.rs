use super::*;

fn frames() -> Vec<Value> {
    let fixture: Value = serde_json::from_str(include_str!("activity-credit-wal.json")).unwrap();
    fixture["frames"].as_array().unwrap().clone()
}

#[test]
fn recorded_native_credit_admission_is_not_reported_as_finalized_payment() {
    let frames = frames();
    let entity = frames[0]["runtimeInput"]["entityInputs"][0]["entityId"].clone();
    let query = normalized_query(&json!({"entityId":entity,"scanLimit":1,"limit":100})).unwrap();
    for height in [10, 13] {
        let page = read_page(
            "native-h1",
            13,
            &{
                let mut query = query.clone();
                query["beforeHeight"] = json!(height);
                query
            },
            |requested| {
                Ok(frames
                    .iter()
                    .find(|frame| frame["height"] == requested)
                    .unwrap()
                    .clone())
            },
        )
        .unwrap();
        assert_eq!(page["returned"], 3);
        assert_eq!(page["scannedFrames"], 1);
        assert_eq!(page["nextBeforeHeight"], height - 1);
        for event in page["events"].as_array().unwrap() {
            assert_eq!(event["rawType"], "extendCredit");
            assert_eq!(event["source"], "runtime_input");
            assert_eq!(event["status"], "queued");
            assert_eq!(event["entityId"], entity);
            assert_eq!(event["height"], height);
            assert_eq!(
                event["amount"],
                if event["tokenId"] == 2 {
                    "2000000000000000000000"
                } else {
                    "2000000000000"
                }
            );
            assert!(!event["title"].as_str().unwrap().contains("finalized"));
        }
    }
}

#[test]
fn recorded_activity_search_entity_time_and_scan_filters_do_not_invent_missing_history() {
    let frames = frames();
    let frame = frames.iter().find(|frame| frame["height"] == 13).unwrap();
    let query =
        normalized_query(&json!({"types":"extendCredit","query":"EXTENDCREDIT","scanLimit":1}))
            .unwrap();
    assert_eq!(
        read_page("native-h1", 13, &query, |_| Ok(frame.clone())).unwrap()["returned"],
        3
    );
    for filter in [
        json!({"entityId":format!("0x{}","f".repeat(64))}),
        json!({"kind":"onchain"}),
        json!({"fromTimestamp":frame["timestamp"].as_u64().unwrap()+1}),
    ] {
        let mut query = query.clone();
        query
            .as_object_mut()
            .unwrap()
            .extend(filter.as_object().unwrap().clone());
        assert_eq!(
            read_page("native-h1", 13, &query, |_| Ok(frame.clone())).unwrap()["returned"],
            0
        );
    }
    let query = normalized_query(&json!({"query":"not-present","scanLimit":2})).unwrap();
    let result = read_page("native-h1", 13, &query, |height| {
        frames
            .iter()
            .find(|frame| frame["height"] == height)
            .cloned()
            .ok_or_else(|| format!("ACTIVITY_WAL_MISSING:{height}"))
    });
    assert_eq!(result.unwrap_err(), "ACTIVITY_WAL_MISSING:12");
}
