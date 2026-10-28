use xln_rscore_protocol::{JS_MAX_SAFE_INTEGER, UnixMs, UnixS};

#[test]
fn time_conversion_is_explicit_exact_and_bounded_like_typescript() {
    for (ms, seconds) in [(1000, 1), (1999, 1), (2000, 2)] {
        assert_eq!(UnixMs::new(ms).unwrap().floor_seconds().get(), seconds);
    }
    assert_eq!(UnixS::new(1).unwrap().to_millis().unwrap().get(), 1000);
    assert!(UnixMs::new(JS_MAX_SAFE_INTEGER + 1).is_err());
    assert!(UnixS::new(JS_MAX_SAFE_INTEGER + 1).is_err());
    assert!(
        UnixS::new(JS_MAX_SAFE_INTEGER)
            .unwrap()
            .to_millis()
            .is_err()
    );
}
