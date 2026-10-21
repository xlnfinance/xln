# Registered relay authority and React settings

Numbered Entities could register successfully but their gossip profiles were rejected by the stateless relay. The managed relay now verifies profiles through its own H1 authenticated control endpoint and committed certified registry. The standalone API relay reads its own committed registry. Profile-controlled endpoints and supplied-board authority are not accepted.

The control request uses the existing canonical binary codec and the original profile size limit plus its framing byte. This preserves valid large profiles without enlarging the profile admission bound. Real signed-profile regressions cover authentication, descriptor tampering, board rotation, oversized bodies and rejection of the retired JSON request.

React Settings now exposes the existing Stack Manager service through an authenticated administrator connection. Signing stays on the hosting runtime. Its actual Anvil deployment, receipt verification and community publication passed at three viewport sizes. Tutorial header CSS is scoped to the header so Settings chapter buttons wrap on mobile.

Focused verification on the recorded source bytes: 93/93 L1 tests with 634 assertions; 2/2 strict browser cases for registered ownership and Stack Manager; 1/1 theme case with both light/dark reload and same-wallet identity checks. Full commands, source hashes, durations and log hashes are in proof.json.

These are intermediate checks. Full release, final-SHA financial coverage, public chain funding/deployment and final public browser verification are outstanding. Original failures and the separate missing React mascot behavior remain recorded.

After relocating the two new modules to preserve the existing directory width invariant, the same 93 L1 tests and exact registered-ownership browser case passed again. Only import locations changed; the full check failure and its required repeat remain explicit in proof.json.

The HTTP request owns an ArrayBuffer-backed copy of the canonical bytes to satisfy the DOM fetch contract without a type assertion. The exact runtime contract type check and all 93 focused L1 tests passed after that change; subsequent whole-check and browser records are named in proof.json.
