# xln — карта папок и работ

Срез: `main` @ `566c850b3`, 2026-09-25. Это **спецификация владения**, не учебник по платежу. Каждая карточка: папка, **I** (что получает и от кого), **O** (что отдаёт и кому), **S** (состояние на доступном evidence), **Δ** (три задачи по порядку). Когда карточка называет несколько папок, агент получает **одну конкретную папку**, а один интегратор сверяет их общий I/O. Сквозной flow сам по себе владельцем state machine не становится.

## Root review — 2026-09-30

The short external-reader path is root `readme.md` → `docs/intro.md` → J/E/A,
RCPAN and the canonical cascade. Runtime/Entity/Account code lives in `core/`,
Solidity J enforcement in `jurisdictions/`, the Rust implementation in `rscore/`,
wallets in `ui/` and `frontend/`, and canonical prose in `docs/`.

- Root build/TypeScript/toolchain configuration, `AGENTS.md`, license/version,
  package manifest and lockfile have actual tooling roles; they are not clutter
  to delete merely because an external reader does not need them.
- `CLAUDE.md` is an agent-workflow pointer. `todo.md` is the single live release
  checklist. Keep their authority distinct from the dated reports in this map.
- `hlt-runs.json` and `foundation-release-board.json` are relocatable operational
  data, but have live consumers in `scripts/hlt-progress.ts` and release tools.
  Move them only together with those readers/writers; they are not proven dead files.
- Local `.DS_Store` and `.tmp-*.log` are generated root clutter, not architecture.
  `dist/`, `test-results/`, temporary DBs and logs likewise need retention/cleanup
  policy; names alone do not establish that recovery data or evidence is disposable.
- [Minimum remaining work](launch-design.md#minimum-remaining-work--owner-alignment-2026-09-30)
  gives the current implementation order. The September 25 figures below are
  historical evidence, not current release readiness or author-awarded scores.

## Решение для владельца

- **Сейчас:** production mixed WAL доказал exact TS/Rust W1/W4/W8 parity на 134/134 кадрах: roots R/E/A и ordered event/effect/outbox. Live Rust H1 W1/W4 дал 650/650 платежей каждый, J watcher и `r2r/r2c/c2r` с onchain money conservation. `bun run check` зелёный после исправлений. Из 12 основных browser E2E прошли 11; cross-J выявил протокольную развилку: один подписанный `fillRatio` при полном получении 0.03 WETH списывает весь лимит 78 USDC, хотя матчинг исполняется по ask 75 USDC. Открыты решение этого контракта, полный transaction-kind production coverage и валидный 20-секундный TPS.
- **Не путать статус:** `todo.md` от 2026-09-05 фиксирует старые red для Rust restore, Tron receipt proof и lending admission; `docs/night-work-plan.md` от 2026-09-18 — локальный native recovery и блокеры публичных сервисов/signing. HEAD от 2026-09-23 мог их изменить. Каждое надо перепроверить, а не объявлять текущим дефектом.
- **Команды:** один implementer на один R/E/A/J transition. Rust mirror и reviewer вступают после стабильного diff. UI, QA, relay и ops могут идти рядом, если не меняют этот контракт.

**Проверенное 25.09:** immutable WAL — `.logs/hlt-evidence/2026-09-25T03-13-05-243Z/recording-manifest.json`; полный parity log — там же `full-parity.log` (**6/6 движков, 134 кадра**). Live Rust evidence — `.logs/hlt-live-rust-130-w{1,4}/` (**650/650 платежей и три Move-направления в каждом**). Rust W4 apply 815.8 мс против W1 1771.0 мс в replay (**2.17×**); live apply 441 мс против 726 мс (**1.64×**). Это малая функциональная нагрузка, не release TPS. Последний `bun run check`: **green**, Rust runtime suite **352/352**.

## Размеры: source, чистые строки, документация

`N/C/D` ниже означает: физические строки исходника / приблизительно непустые строки без строк-комментариев / строки **прямо привязанной** документации. C — лексический счёт, не оценка полезности. Все числа из отслеживаемых Git файлов; тесты, fixtures, generated и архив исключены из размеров модулей. Общие specs не размножены по папкам.

- Runtime **23 410/20 761/197**; Entity **45 290/39 922/70**; Account **18 723/16 212/198**.
- Jurisdiction вместе с adapter **24 168/21 456/56**; storage **23 875/21 530/591**; protocol **9 313/7 503/1 156** (docs общие с RJEA/FinTS).
- Network **11 083/9 860/30**; Orderbook **2 700/2 320/24**; Watchtower **4 573/4 138/111**; API **16 557/15 107**, прямой отдельный doc не выделен.
- Rust crates без тестов **178 446 физических**; web `frontend/src/` **130 169**; native React `ui/src/` **18 614**. Все отслеживаемые исходники вместе **1 124 990**, включая **294 540 строк тестов** и **56 938 строк vendor**.
- Markdown считается отдельно: **118 330 строк** по репозиторию. Из **78 844 строк `docs/`** ровно **57 571** — 22 исторических release snapshots. Поддерживаемые docs без release/evidence/audit — **19 634**. Это не 78 тысяч строк действующей спецификации.

## P0 — один протокол и долговечный результат

### 01 · `core/types/` + `core/protocol/` — общий контракт

- **I:** типы команд и signed wire-данные от Runtime, Entity, Account, J.
- **O:** канонические байты, hashes, identity, HTLC и state primitives для всех машин, WAL и Rust.
- **S:** TS/Rust wire/root parity 6/6 на mixed WAL; Solidity vector отдельно остаётся final gate.
- **Δ:** 1) именованный wire/hash vector; 2) карта всех читателей перед удалением alias; 3) один актуальный codec без совместимых обходных путей.

### 02 · `core/runtime/admit/` + `mempool/` — вход и reject · 3 700 LOC

- **I:** API-команды, P2P envelopes, J-события, scheduled wake.
- **O:** канонический `RuntimeInput` в `frame/`; typed reject ровно одной неверной tx.
- **S:** mixed production replay 134/134 exact; adversarial reject одной tx остаётся отдельным vector.
- **Δ:** 1) reject одной tx в lane; 2) порядок peer/user inputs; 3) причина reject в диагностике без чтения env внутри перехода.

### 03 · `core/runtime/frame/` + `loop/` — кадр · 5 256 LOC

- **I:** один `RuntimeInput` и последний committed Runtime state.
- **O:** кандидат `RuntimeFrame`, ordered Entity/Account outputs и план WAL commit.
- **S:** mixed WAL exact 134/134 на TS/Rust W1/W4/W8; header-only J следующий Entity frame зафиксирован регрессией.
- **Δ:** 1) первый divergent frame; 2) exact порядок inbound Account → Entity work → outbound Account; 3) убрать только измеренную лишнюю копию кандидата.

### 04 · `core/entity/consensus/` — сертификат Entity · 12 114 LOC

- **I:** `EntityInput`, board signatures, предыдущий Entity state.
- **O:** certified `EntityFrame`, root и ordered secondary hash manifest в Runtime.
- **S:** Entity root и ordered events совпали по всем 134 кадрам на 6 движках.
- **Δ:** 1) exact manifest при replay; 2) candidate/committed isolation при отказе; 3) делить по `input/`, `proposal/`, `frame/`, `commit/` после parity.

### 05 · `core/entity/tx/` — Entity-owned работа · 20 201 LOC

- **I:** validated `EntityTx`, J facts, Account inputs и команды продуктов.
- **O:** новый Entity state; локальные `AccountTx`, точные `AccountInput` и outputs в Runtime.
- **S:** mixed HLT replay exact по 134 кадрам; все 63 вида EntityTx ещё не представлены в одном production WAL.
- **Δ:** 1) трасса стадий 1/2/3; 2) один владелец для каждого `AccountTx` admission; 3) финальная transaction-kind completeness после production parity. Малые пакеты: `handlers/account/`, `payments/`, `cross-j/`, `j-batch/`, `dispute/`.

### 06 · `core/account/consensus/` — двусторонний кадр · 5 938 LOC

- **I:** peer proposal/ACK/ACK+frame/dispute и локальный Account replica.
- **O:** committed `AccountFrame`, сохранённый duplicate response или typed reject в Entity.
- **S:** strict recorder проверил checkpoint и full restart; mixed replay Account roots exact. Отдельные adversarial ACK vectors остаются release gate.
- **Δ:** 1) exact duplicate без append; 2) LEFT collision и разный hash/height rejection; 3) ACK cost менять только после профиля. Пакеты: `incoming/`, `proposal/`, `frame/`, `dispute/`.

### 07 · `core/account/tx/` — деньги и обязательства · 4 952 LOC

- **I:** локально допущенный `AccountTx`, предыдущее `AccountState`, certified J claim.
- **O:** новый `AccountState`/root и финансовые outputs для bilateral consensus.
- **S:** mixed replay Account roots exact; 21 вид AccountTx перечислен в каталоге, 4 пока имеют только общий mixed replay как evidence.
- **Δ:** 1) на первом расходящемся Account сверить обе стороны и `deriveDelta`; 2) deadline/HTLC/J-finality adversarial vectors; 3) удалять дубли финансовой формулы только с TS/Rust parity. Отдельные агенты: `handlers/{settlement,swap,balance,rebalance,j-events,htlc}/`, по одному виду tx.

### 08 · `core/jurisdiction/machine/` — certified J facts · 7 090 LOC

- **I:** проверенные chain observations из adapter, Entity batch и signer evidence.
- **O:** certified J-prefix/events в Entity и Account; batch commitment для submit.
- **S:** live Rust W1/W4 проверил watcher, финализацию J и onchain `r2r/r2c/c2r`; J nonce продвинулся в обоих прогонах.
- **Δ:** 1) один watcher event до J-prefix; 2) signer threshold и event order; 3) чистый normalizer без второй authority. Пакеты: `events/`, `history-consensus/`, `batch/`.

### 09 · `core/jurisdiction/adapter/` — внешняя сеть · 16 835 LOC

- **I:** RPC blocks/logs/receipts и committed submit intent из Runtime.
- **O:** authenticated observations для J machine; chain receipt/error для Runtime.
- **S:** RPC и BrowserVM есть; в `todo.md` был Tron receipt-proof red 2026-09-05, свежая проверка нужна.
- **Δ:** 1) реальный watcher/receipt на целевой сети; 2) BrowserVM оставить dev evidence, не production; 3) измерить polling lag/retry. Пакеты: `rpc/`, `watcher/`, `events/`.

### 10 · `core/runtime/j-submit/` — отправка J batch · 2 425 LOC

- **I:** committed J batch intent после WAL, ответы chain adapter.
- **O:** submission/receipt lifecycle и следующий `RuntimeInput`.
- **S:** live Rust W1/W4 прошёл watcher → Entity → batch → receipt и три направления Move.
- **Δ:** 1) пройти всю live цепочку; 2) retry без двойного эффекта; 3) latency/cause counters по фазам.

### 11 · `core/storage/commit/` + `wal/` + `database/` — durable граница · 4 480 LOC

- **I:** Runtime candidate, canonical input bytes и ordered outbox.
- **O:** fsynced WAL/HEAD/outbox, которые recovery может перечитать.
- **S:** strict checkpoint/full restart и mixed replay прошли; `bun run check` зелёный после восстановления локальных Hardhat 3 и forge-std.
- **Δ:** 1) commit до эффектов на одном кадре; 2) persisted bytes/root/digest; 3) удалить измеренный duplicate encode/hash, без нового durable oracle.

### 12 · `core/storage/recovery/` + `read/` — восстановление · 8 095 LOC

- **I:** checkpoint, ordered Runtime WAL inputs и stored commitments.
- **O:** восстановленный R/E/A state либо первый mismatched frame/root/output digest.
- **S:** код есть; старый Rust restore red в `todo.md` требует повторного прогона на HEAD.
- **Δ:** 1) exact replay каждого кадра; 2) crash до/после publication; 3) подробный Account dump только после первого mismatch.

### 13 · `core/runtime/delivery/` — post-WAL outbox · 3 896 LOC

- **I:** committed Runtime outputs, адресация peer/Entity/J.
- **O:** точные envelopes в P2P/API/J и retry state; ACK/receipt назад в ingress.
- **S:** код есть; найден точный дубль route-key merge в `pending.ts` и `plan.ts`.
- **Δ:** 1) защитить порядок первого принятого output; 2) объединить 23-строчный merge; 3) reconnect/restart без потери или двойного эффекта.

### 14 · `core/hanko/` + `jurisdictions/contracts/` — proof и onchain enforcement

- **I:** certified Entity/Account state, signer authority, nonce, старый state и J batch.
- **O:** Hanko/proof, contract state transition, chain events в watcher.
- **S:** TS и Solidity код есть; полный cross-language hash/bytecode gate не проведён. Solidity source: **6 605 LOC**; `core/hanko/`: **2 275 LOC**.
- **Δ:** 1) один TS/Rust/Solidity proof vector; 2) signer/nonce/old→new/dispute counterexample; 3) при Solidity change синхронные artifacts/typechain и bytecode review. Подпапки контрактов и Account/Depository/EntityProvider должны иметь одного владельца изменения proof.

### 15 · `core/rscore/` — TS↔Rust граница · 14 470 LOC

- **I:** точные R/E/A inputs, checkpoint, wire codec, worker count.
- **O:** Rust call/result и per-frame parity evidence в TS Runtime/QA.
- **S:** bridge прошёл 6/6 TS/Rust W1/W4/W8 parity. `core/rscore/` — TypeScript worker и IPC, Rust код живёт отдельно в `rscore/crates/`; папку целиком удалять нельзя.
- **Δ:** 1) один immutable WAL; 2) первый divergent frame; 3) live J после полного replay. Не вводить отдельную денежную формулу в bridge.

### 16 · `rscore/crates/engine/` — Rust Account · 23 351 LOC

- **I:** canonical Account input/wire и предыдущий Rust Account state.
- **O:** Account root, ordered outputs и frame, равные TS Account.
- **S:** Account roots exact на 134 кадрах/6 режимах; release binary и Rust workspace tests прошли `bun run check`.
- **Δ:** 1) один именованный AccountTx vector; 2) exact root/output на mixed WAL; 3) убрать доказанную параллельную формулу. Пакеты: `src/tx/` 7 104, `consensus/` 6 169, `j_claims/` 2 605.

### 17 · `rscore/crates/entity-kernel/` — Rust Entity · 56 304 LOC

- **I:** EntityInput, Rust Account results, J events и book/paybook work.
- **O:** Entity root, ordered outputs, candidate/certificate data для Rust Runtime.
- **S:** Entity root и ordered outputs exact на 134 кадрах/6 режимах; cross-J/lending остаются отдельными fixture vectors.
- **Δ:** 1) три стадии против TS; 2) J-event→Account путь; 3) измерить shard/batch cost до оптимизации. Пакеты: `local_financial/` 7 422, `cross_j/` 8 456, `consensus/` 4 514, `orderbook/` 4 189.

### 18 · `rscore/crates/runtime/` + `batch/` + `process/` — Rust live R · 90 096 LOC

- **I:** checkpoint/WAL, RuntimeInput, результаты Rust Entity/Account, J watcher.
- **O:** Runtime roots и ordered outbox; live эффекты после commit.
- **S:** exact replay и live J W1/W4 прошли; 130-user функциональный стенд не является валидным 20-секундным TPS.
- **Δ:** 1) exact W1/W4 replay; 2) live J watcher→receipt; 3) фазовый профиль/Amdahl и только затем H1 TPS. Пакеты: `runtime/src/{machine,processor,restore,j_watcher,j_submit}/`.

## P1 — экономические продукты и сервисы

### 19 · `core/entity/paybook/` — жизнь HTLC платежа · 1 190 LOC

- **I:** payment EntityTx, route/capacity, J height, входящий Account lock/secret/ACK.
- **O:** запись по hashlock; ordered forward/settle/fail/refund intents в Account и итоговое событие Runtime.
- **S:** код есть; local payment/recovery evidence от 2026-09-18 не закрывает публичный flow на HEAD.
- **Δ:** 1) live payment→уникальный receipt; 2) timeout/restart/refund vector; 3) materialize-context cost только по профилю. Баланс остаётся у Account.

### 20 · `core/orderbook/` — книга и matcher · 2 700 LOC

- **I:** валидированные offer/cancel/resize от Entity, Account eligibility, J pair/finality.
- **O:** price-time ordered matching events, book pages/root и swap-resolve intent в Account.
- **S:** код есть; нынешний same-J/cross-J settled fill на этом SHA здесь не получен.
- **Δ:** 1) live settled fill; 2) TS/Rust order/root vector; 3) проверить hydration индекса, затем оптимизировать matcher. Пакеты: `core.ts`, `pages/`, `cross-j/`, `swap-execution.ts`.

### 21 · `core/extensions/cross-j/` — связь двух J · 2 204 LOC

- **I:** swap terms и состояние finality обеих J из Entity/J machine.
- **O:** bound route/phase, Account/J intents и terminal результат в Runtime.
- **S:** кооперативный source-buyer close теперь переносит точную цену исполнения в Account, освобождая неиспользованный hold; в диспуте действует подписанный максимум. Узкие TS тесты 13/13 и TS/Rust компиляция зелёные; browser E2E и TS/Rust parity нового контракта ещё проверяются. Полный live Rust/J cross-J проход не подтверждён.
- **Δ:** 1) провести full/partial/disputed swap до обоих receipts; 2) TS/Rust replay и onchain dispute vector для выбранного контракта; 3) проверить экономику Хаба по обоим активам, включая округление.

### 22 · `core/pathfinding/` — маршрут и quote · 546 LOC

- **I:** Hub profiles/capacity/fees, актив, сумма и direction.
- **O:** исполнимый route/quote в Paybook/UI либо причина отсутствия пути.
- **S:** код есть; executable depth на текущем live mesh не измерена.
- **Δ:** 1) сверить quote с реальной доступной capacity; 2) сделать отказ объяснимым; 3) кэшировать только после измерения.

### 23 · `core/orchestrator/market-maker/` — котировки MM · 7 087 LOC

- **I:** Hub profiles, Account balances/capacity, token catalog, J RPC, quote policy.
- **O:** account-open/connectivity Entity inputs, same-J/cross-J offers, health по исполнимой глубине.
- **S:** код есть; число отправленных quotes не доказывает ликвидность, независимых операторов или settled volume.
- **Δ:** 1) измерить executable amount/price и committed fills; 2) делить `mm-node-run.ts` 2 473 LOC по lifecycle; 3) убрать дубли health только после карты callers.

### 24 · `core/extensions/lending.ts` + Account handlers — кредит и rebalance

- **I:** lending/pull/rebalance intent и committed collateral/capacity.
- **O:** типизированный AccountTx, bilateral frame и финансовый receipt.
- **S:** handlers есть; `todo.md` от 2026-09-05 фиксировал red `lending_fund` admission, требуется focused rerun.
- **Δ:** 1) named vector на каждый вид tx; 2) funding/close/reload; 3) UI exposure/fee только из committed Account.

### 25 · `core/runtime/registration/` + `core/entity/auth/` — identity/board

- **I:** signed registration/board update и certified J registry event.
- **O:** authorised Runtime/Entity identity, board/profile descriptor для verifier.
- **S:** код есть; governance/retired signer evidence остаётся final gate этого отчёта.
- **Δ:** 1) board rotation; 2) retired signer rejection; 3) provenance ключей в operator health.

### 26 · `core/network/{p2p,relay}/` — связь Runtimes · 11 060 LOC

- **I:** committed outbox, remote authenticated envelopes, endpoint/gossip metadata.
- **O:** verified inbound Runtime input, reconnect/delivery status и discovery.
- **S:** код есть; transport loss и pending Account ACK на полном H1 gate здесь не измерены.
- **Δ:** 1) reconnect с тем же outbox; 2) peer auth/session close отдельно от financial reject; 3) zero-loss/drain метрика.

### 27 · `core/watchtower/` — backup и последний спор · 4 573 LOC

- **I:** signed encrypted archive/appointment, quota policy, chain dispute event.
- **O:** blind restore bytes, signed tower receipt, delayed counter-dispute action.
- **S:** локальное archive→fresh restore evidence описано 2026-09-18; публичная tower готовность не доказана.
- **Δ:** 1) upload→fresh restore; 2) quota rejection с сохранением предыдущей копии; 3) live last-resort dispute timing.

### 28 · `frontend/src/lib/stores/vault/` + `ui/src/runtime/` — wallet/recovery

- **I:** seed/keys, local store, encrypted tower archive, canonical checkpoint.
- **O:** восстановленная session/state, typed commands и committed history/receipts.
- **S:** локальный recovery→new payment подтверждён в плане 2026-09-18; физическое устройство/публичный flow не подтверждены.
- **Δ:** 1) fresh-device backup→restore→new payment; 2) interruption до publication; 3) показать честный выбор recovery в UI.

### 29 · `brainvault/src/core/` — remembered-secret wallet · 603 canonical LOC

- **I:** exact username/password/shards/multiplier и pinned Argon2id/BLAKE3 recipe.
- **O:** детерминированный root, две mnemonic/key/address проекции локально.
- **S:** portable wallet meaning 603 строки; огромный `src/native/` включает ускорители/vendor, не размер протокола.
- **Δ:** 1) одинаковый root при любом engine/worker count; 2) fresh-process address перед финансированием; 3) portable core держать отдельно от acceleration.

### 30 · `core/api/{public,server,runtime-adapter}/` — API · 16 557 LOC

- **I:** typed CLI/UI commands и последний WAL committed Runtime state.
- **O:** допущенная Runtime command, HTTP/WS response, read-only projection.
- **S:** код есть; `resolve.ts` 2 208 LOC смешивает route/recovery/view, точная готовность всех flows не проверена.
- **Δ:** 1) один contract command→final receipt; 2) public read только committed state; 3) делить `resolve.ts` по caller map.

### 31 · `core/orchestrator/` — запуск Hubs/MM · 24 138 LOC

- **I:** config, DB, signer, network и J endpoints.
- **O:** запущенные процессы, readiness/health, MM intents в Runtime.
- **S:** код есть; `docs/night-work-plan.md` сообщал offline H1–H3 2026-09-18, текущий public health не измерен.
- **Δ:** 1) restart H1–H3/MM без ручной правки; 2) J readiness отдельно от P2P auth; 3) health по исполнимой ликвидности.

### 32 · `custody/` — служебный вывод активов · 3 735 LOC

- **I:** signed custody admission/withdrawal request и chain status.
- **O:** authorized withdrawal, durable journal и operator ledger response.
- **S:** сервис есть; restart/replay и onchain reconciliation здесь не прогонялись.
- **Δ:** 1) signed admission; 2) nonce/replay после restart; 3) сверка журнала с chain balance.

## P2 — представления, инструменты, доказательства

### 33 · `frontend/src/` — web · 130 169 LOC

- **I:** user action, vault/session и API projection.
- **O:** typed Runtime commands, committed balance/receipt/recovery screens.
- **S:** код есть; browser/F12 на текущем SHA здесь не проводился. `components/Entity/` — 41 622 LOC, слишком широко для одного агента.
- **Δ:** 1) pay/swap/recovery по receipt; 2) назначать экраны по flow (`pay`, `swap`, `assets`, `workspace`); 3) лишний refresh удалять по профилю, не по размеру файла.

### 34 · `ui/src/` + `native/` — mobile/desktop · 18 614+ LOC

- **I:** native host bridge, vault state, API/runtime adapter.
- **O:** typed commands, native screens, receipts и restored wallet.
- **S:** simulator evidence есть за 2026-09-18; physical device, signing и public install не доказаны.
- **Δ:** 1) pay/swap/fresh restore на устройстве; 2) camera denial и VoiceOver; 3) отделить platform wrapper от общего typed client.

### 35 · `cli/` — терминальный клиент · 3 283 LOC

- **I:** args/profile пользователя, daemon API.
- **O:** typed pay/swap/open/move/lend command и финальный receipt в терминале.
- **S:** код есть; receipt/restart сценарий здесь не запускался.
- **Δ:** 1) наблюдаемый final receipt; 2) ошибки daemon/user input; 3) retry без двойного платежа.

### 36 · `core/qa/` + `core/scenarios/` + `tests/` — доказательства

- **I:** production artifact, invariant и exact input.
- **O:** первый divergent frame, named regression и gate evidence.
- **S:** `bun run check`, exact parity 6/6 и live Rust J W1/W4 прошли. Основные browser E2E 11/12; cross-J заблокирован ценовым контрактом. Валидный TPS остаётся открытым.
- **Δ:** 1) named regression на первый mismatch; 2) completeness только после production WAL; 3) считать уникальные settled операции. `core/qa/report.ts` 2 998 LOC делить по реальным output consumers.

### 37 · `scripts/` + `core/scripts/` + `tools/` — запуск и gate

- **I:** точный SHA, config, stand resources и команды проверки.
- **O:** build/run artifact, health, test/replay/performance evidence.
- **S:** `bun run check` зелёный; локальные зависимости восстановлены из lockfile и штатного `forge:setup`, tracked artifacts не изменились.
- **Δ:** 1) восстановить зависимости и тот же gate; 2) сохранить lock для тяжёлых стендов; 3) свести 14-строчный duplicate child-process wait в release runners.

### 38 · `ai/` + `debates/` — опциональные интерфейсы

- **I:** prompt пользователя и разрешённые read APIs.
- **O:** ответ/артефакт; прямого права менять consensus state нет.
- **S:** код есть; доказанной роли в release critical path нет.
- **Δ:** 1) typed permission boundary; 2) удалить только доказанный unused путь; 3) не включать в launch gate без полезной экономической ценности.

## Удаление и дедуп: конкретный shortlist

1. **Первый по ценности:** `core/runtime/delivery/pending.ts:398–422` и `plan.ts:27–51` — один и тот же 23-строчный merge route keys. Один helper после regression на input position/output digest. Риск средний.
2. **Низкий риск UI:** `EntityAssetsTab.svelte:228` и `AccountWorkspaceView.svelte:342` — одинаковая передача MoveWorkspace props, 41 строка. Один типизированный владелец; проверить browser/F12.
3. **Низкий риск ops:** `run-capped-testnet-gate.ts:228` и `run-mainnet-preflight-gate.ts:188` — одинаковый 14-строчный child wait. Общий process helper с теми же timeout/exit semantics.
4. **Сценарии/оператор:** 46 строк Bob credit setup повторяются в `ahb.ts`/`lock-ahb.ts`; 15 строк registry retry — в `hub-node.ts`/`mm-node-core.ts`. Делить fixture и operational helper, не финансовый reducer.
5. **Осторожно:** одинаковые validators в `core/storage/schema/account-layout.ts:169–184` и `entity/layout.ts:125–140`. Recovery roots обязательны до удаления одной копии.
6. **Не мусор, но тяжело владеть:** `EntityPanelTabs.svelte` 2 917 LOC, `SwapPanel.svelte` 2 880, `Graph3DPanel.svelte` 2 635, `vaultStore.ts` 2 884, `core/api/runtime-adapter/resolve.ts` 2 208, `core/qa/report.ts` 2 998. Делить по action/caller, не удалять по длине.
7. **Не удалять архив:** `docs/releases/` — 22 snapshot-файла / 57 571 строк. Для будущих релизов хранить большой code snapshot как отдельный artifact; исторические ссылки сохранять.

**Контракт завершения задачи:** SHA, последний green, первый red/error, immutable artifact, следующая одна команда, оставшиеся gates. Для R/E/A/J — L1 vector → production-equivalent L2 → `bun run check`; для recorder/replay/HLT/TPS сначала `bun run stand:status` и machine lock.

**Контроль времени:** у каждой попытки один проверяемый результат и лимит 10 минут без нового evidence. По истечении лимита фиксировать первый red и менять гипотезу или способ проверки; не повторять ту же команду без изменения причины. Один тяжёлый стенд, один владелец изменяемой папки, отдельный reviewer после стабильного diff.
