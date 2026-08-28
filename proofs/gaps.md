# proofs/gaps.md — реестр требований аудитов (до 100/100)

Правило: каждый пункт «100/100 gap list» каждого закоммиченного аудита обязан
иметь здесь статус. Статусы: `CLOSED <commit>` / `WAVE-2026-08-28` (закрыто
пост-аудитной волной, на момент регистрации не закоммичено) / `OPEN` / `OWNER`
(требует решения владельца). Регистрация: 2026-08-28 (программный аудит),
обновляется при каждом закрытии.

## c1-adversary (74/100)

| # | Требование | Статус |
|---|---|---|
| 1 | Re-pin: relabel seed + rebuild + повтор 4 корпусов на новом immutable SHA | PARTIAL: generator fix `935020a41`; coordinator full rerun на clean immutable `b7e3ace82` = 80,656/0. Independent repro-аудит на post-FX bytes — OPEN |
| 2 | Починка shrinker'а (уникальные id кандидатов) + калибровка ≥3 режимов саботажа | WAVE-2026-08-28: unique deterministic IDs, tested-slice restriction, failure-signature preservation; content-hex/class-inversion/field-divergence = 1/1 each |
| 3 | Duplicate-parity: прод-проверка в TS-энкодере ИЛИ переформулировка свойства (reference-key асимметрия) | OPEN |
| 4 | Перечислить семейство асимметрий: сиды tokenId>65535, timeInForce>255, jHeight>2^53, hashlock/EntityId/envelope | PARTIAL WAVE-2026-08-28: tokenId/timeInForce/jHeight/hashlock/EntityId seeds added and checked; envelope malformed cases — OPEN |
| 5 | Flat duplicate paths: исключить из модели или контрактный tie-break + ≥21-entry проба | PARTIAL WAVE-2026-08-28: 21-entry probe passes; contractual tie-break or domain exclusion — OPEN |
| 6 | TS-only виды: 3/14 → все 14 (или явно 3/14 в claim) | OPEN |
| 7 | Edge-сид: j_event с 0 событий; unknown tx field; `__proto__`; wObj-dup без драйвер-интерсептора | PARTIAL WAVE-2026-08-28: zero-event, unknown-field known-divergence + exact production reject, and `__proto__` added; raw wObj-dup production semantics — OPEN |
| 8 | Coverage ledger: per-pair/per-branch счётчики | PARTIAL WAVE-2026-08-28: class/kind/TS↔Rust outcome/tx-kind ledger emitted; internal encoder branch ledger — OPEN |

## c1-repro (92/100; `findings.md` закоммичен `9aa5affbe`, audited subject `dfd45cc7c`)

| # | Требование | Статус |
|---|---|---|
| 1 | Исходный прогон на грязном дереве невосстановим из git | CLOSED эквивалентностью: c1-repro независимо пересобрал и повторил 80,656/0 из clean `git archive dfd45cc7c`; исходные dirty bytes всё равно не реконструируются |
| 2 | Seed 31337 не перепрогнан | WAVE-2026-08-28: clean `e69630fca` + proof-only fix, 10,114/0; требуется независимый repro на immutable SHA |
| 3 | Обёртка саботаж-калибровки минимизатора не закоммичена | OPEN (связано с c1-adv#2) |
| 4–5 | Генераторные гэпы / driver-substituted both-reject | OPEN (= c1-adv #4–7, #3) |
| 6 | Stale label корпуса | WAVE-2026-08-28 (корпус `d483605e2` + generate.ts волной) |

## c2-adversary (55/100)

| # | Требование | Статус |
|---|---|---|
| 1–7 | Непустые карты, delete-путь, инстанцирование 4 неймспейсов, генерация конфликтов + D4-векторы, EntityAccountCandidateMap/leaf-registry, post-finality clock | CLOSED `b8004d939` (7 коллекций непусты; lending/subcontracts/shadow — вне профиля, см. #8) |
| 8 | Dispute/`external_finality`/settle_transition kinds, `settlementWorkspaceHash ≠ null` | OPEN |
| 9 | Double rollback / повторная коллизия pin | OPEN |
| 10 | Мультилистовые deltas >5 зарегистрированных токенов, граничные tokenId | OPEN |
| 11 | Честный учёт (900, не 1,200) + per-op-kind счётчики | CLOSED (текст отчёта; матрица — WAVE-2026-08-28) |
| 12 | Воспроизводимость: коммит артефактов + чистый SHA | CLOSED `d483605e2`+`b8004d939`; re-audit чистое извлечение `78e07d9a9` — точно |
| A9 | Witness lifecycle (прунинг, state-resolution ACK-хэши) | OPEN |

## c2-repro replacement (91/100)

| # | Требование | Статус |
|---|---|---|
| 1 | Оригинальный c2-repro 88/100 не был закоммичен и невосстановим | CLOSED только заменой: независимый re-audit `b043199fe`; потеря исходного отчёта остаётся coordinator error |
| 2 | Fresh-seed run сверх трёх фиксированных seed'ов | OPEN |
| 3 | Коммит, воспроизводящий исторический pre-FX-3 throw | UNRECOVERABLE: фикс посажен до первого C2 evidence commit; не использовать как воспроизводимый claim |
| 4 | Унаследованные coverage-gap'ы C2 | OPEN (= c2-adversary #8–10, A9) |

## c4-adversary (78/100)

| # | Требование | Статус |
|---|---|---|
| 1–3 | Debt lifecycle reach; debt-bookkeeping инварианты; реальный `invariant_debtNeverEntersValuePool` | CLOSED `aecfed195` |
| 4 | Transformer shapes: multi-index/multi-clause/invalid arrays/fault modes/decoder path | PARTIAL `aecfed195`: 6 fault-модей, multi-index и decoder закрыты; multi-clause chaining и invalid allowance arrays — OPEN |
| 5 | Асимметричные окна 50/70 + side-selection + closeDispute + invalid witness | CLOSED `aecfed195` |
| 6 | repay-действие (clamp oracle восстанавливается после shortfall) | CLOSED `aecfed195` |
| 7 | `check_gateZeroConcrete` закоммичен + single-clause warning | CLOSED `aecfed195` |
| 8 | Halmos-широта: full-domain clamp с sentinel-ветками, non-representable revert, allowance-validity леммы | OPEN |
| 9 | Hanko: глубокие цепочки (~8–16 claims), registered-board ветка, previous-board grace в dispute-пути | OPEN |
| 10 | Historical-batch replay + `FOUNDRY_PROFILE=deep` 1024×128 | OPEN |
| 11 | Ложный комментарий `ConservationHandler.sol:217-219` (обоснование ограничения неверно) | OPEN (правка тестового файла разрешена, не сделана) |
| 12 | Entry-point sweep: `watchtowerCounterDispute` (finalize-capable), `adminRegisterExternalToken`, ERC721/1155, публичный `enforceDebts` | OPEN |

## c4-repro (92/100)

| # | Требование | Статус |
|---|---|---|
| 1 | Закоммитить C4-артефакты | CLOSED `944353c7c` |
| 2 | DebtChunking: переклассификация тест-vs-дизайн | CLOSED (BUG-09) |
| 3 | BatchBounds 15,049,243 ≥ 15M | OWNER (BUG-08) |
| 4 | Halmos path-count stability note | CLOSED (в отчёте) |
| 5 | typechain/artifacts-регенерация отражена в evidence | OPEN (косметика) |
| 6 | Расширения (истор. replay, deep profile) | OPEN (= c4-adv #10) |

## kani-adversary (83/100)

| # | Требование | Статус |
|---|---|---|
| A1 | W256 кросс-чек: добавить out-of-range кейсы ИЛИ переформулировать строку | Формулировка — WAVE-2026-08-28 (тело отчёта); тест-фикс out-of-range — OPEN |
| A2 | «3 мутанта» → 2 мутанта + сенсор | WAVE-2026-08-28 (тело: `mutant_detection_calibrates_harness`) |
| A3 | «Rust строже» неверно; регистрировать negative-operand расхождение | CLOSED (BUG-06 двусторонний) |
| A4 | Census 11, не 12 | WAVE-2026-08-28 (тело: «All 11») |
| A5 | 73 subset-порядка, не 60 | WAVE-2026-08-28 (тело) |
| A6 | Оговорка callback-контракта `map_slots` | Частично: апендикс отчёта; в тело §3.3 — OPEN (minor) |
| — | Kani-repro аудит (независимый перепрогон 16/16 + эквивалентность) | OPEN (в остаточном плане) |

## c7-adversary (61/100 как «все», 84/100 в скоупе)

| # | Требование | Статус |
|---|---|---|
| 1 | Таргеты по `xln-rscore-runtime` (storage_msgpack, account_input_json, restore/*, j_watcher/abi, native codec) | OPEN (wave-2 прерван квотой) |
| 2 | Гард storage_msgpack + регрессия в корпусе | Гард CLOSED (мейн, `rscore/crates/runtime/src/codec/storage_msgpack.rs:66,130,140`); fuzz-регрессия — OPEN (wave-2) |
| 3 | `decode_wal_runtime_input` (RRS replay), `read_frame`, `decode_onion_layer`, radix-key, HTLC boundary | OPEN |
| 4 | `checkpoint_wire`: реальное свойство (typed-error + budget assert) | OPEN |
| 5 | `orderbook_page`: fuzz-earned acceptance (production hasher в харнессе) | OPEN |
| 6 | Tight Pass B бюджет (убрать 65,536 B slack) | OPEN |
| 7 | Генератор: adversarial BigInt-грамматика, depth≈32, huge-arity claims, claim-probes для abi_envelope | OPEN |
| 8 | F1-skip сузить до точного поля | OPEN |
| 9 | shutdown-сид маппинг / OPS-список | OPEN |
| 10 | Переформулировать C7 на доказанный скоуп | CLOSED (матрица сужена; WAVE-2026-08-28 уточнила) |

## c7-repro (82/100)

| # | Требование | Статус |
|---|---|---|
| 1 | `pin-rscore.sh` неработоспособен как закоммичен | CLOSED `631c68d37` (v2, extraction в `mktemp -d` вне дерева; проверено аудитом 2026-08-28) |
| 2 | Формулировка F1-mitigation («конверт не пропускает») эмпирически неверна | CLOSED (отчёт переписан) |
| 3 | O1 недостижим через закоммиченный харнесс (только public-API) | OPEN (info) |
| 4 | Калибровка B1–B8 (внешний список владельца) | OWNER (список не выдан; readme rule 4 — не выдумывать) |
| 5 | Перепрогнано 2/7 таргетов | OPEN (repro неполный) |
| 6 | libFuzzer логи/cov-дампы не закоммичены | OPEN |
| 7 | Недетерминизм счётчиков exec/cov | OPEN (inherent) |

## Программный уровень (не из аудитов; остаточный план + аудит 2026-08-28)

| Требование | Статус |
|---|---|
| TLA-аудиты ×2 (C3) | OPEN |
| Kani-repro аудит | OPEN |
| C7 wave-2: runtime-декодеры + A2-регрессия + long run | OPEN (прерван квотой провайдера) |
| C8: собственный артефакт (report/SHA/команды/кардинальность) + 2 аудита, либо вывод из матрицы | OPEN (матрица уже честно «❌ не доказано как C8» — WAVE-2026-08-28) |
| FX-1/FX-2 манифест внутри смешанного `64b41da54` | OPEN (файлы: `core/account/tx/admission-policy.ts`, `core/account/input/peer-rejection.ts`, `rscore engine consensus/frame/hash.rs`, `consensus/replica.rs`, `error.rs`, `lib.rs`, тесты `core/__tests__/proofs/fx-admission.test.ts`, `engine/tests/fx_admission.rs`) |
| English-источники proofs/** (`check:english-source` красный) | OPEN |
| folder-width gate | CLOSED на audited worktree: `FOLDER_WIDTH_OK dirs=7022 sourceFiles=3738 max=10/10`; текущий grandfathered debt — `jurisdictions/contracts:16,scripts/dev:12`, не `test/foundry` |
| Финальный `bun run check` | OPEN: 2026-08-28 остановился на `ESLINT_DEBT_CHANGED expected=341/... actual=343/...`; proof-only diff не затрагивает ESLint debt, нужен clean candidate |
| C9/C10 (trace refinement, crash-cutpoint) | фаза 2 |
