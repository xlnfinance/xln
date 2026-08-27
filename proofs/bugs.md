# proofs/bugs.md — единый реестр багов доказательной волны

Статусы: FIXED-ON-MAIN (коммит) / OWNER-DECISION (спека готова, консенсус — решение владельца)
/ CONDITIONAL (модельная находка, production-достижимость не доказана) /
TRIAGE (гигиена, не консенсус) / PARALLEL (закрыто параллельными задачами владельца).

## FIXED-ON-MAIN

| ID | Баг | Источник | Severity | Фикс |
|---|---|---|---|---|
| BUG-01 | TS молча искажает `policyVersion > 2^53` (2^53 и 2^53+1 → одинаковые канонические байты; Rust отказывал) → кросс-движковое расхождение фрейм-хеша | C1 enc-diff | **HIGH** (искажение денежного параметра без следа) | FX-1: единый диапазон `0..2^53-1`, typed reject на admission в обоих движках + хеш-трипвайры; коммит `64b41da54` |
| BUG-02 | `lending_*`/`reserve_to_collateral`: TS исполнял и хешировал, Rust `UnsupportedFrameTx` → кросс-движковый аккаунт затыкался | C1 enc-diff | MED | FX-2: громкий typed reject в обоих направлениях, без TS-fallback; коммит `64b41da54` |
| BUG-03 | Конфликтный `j_event_claim` проходил enqueue без валидации и валил `proposeAccountFrame` голым `throw` → wedge аккаунта навсегда | C2 hot-vs-cold (F1), подтверждено hardening-тестами, чтением общего admission-планнера и re-audit `proofs/audits/c2-repro/report.md` (`b043199fe`) | **HIGH** (доступность, wedge) | FX-3: общий admission-планнер (admit/duplicate/conflict) в обоих движках, typed reject/drop одной строки, аккаунт продолжается; 5 векторов; коммит `190b778e9` |
| BUG-04 | OOM-амплификация в storage-msgpack декодере: `Vec::with_capacity(до 2M)` по wire-заявке до проверки остатка; вложенные маркеры → сотни MiB на десятках байт | C7-adversary (A2), подтверждено чтением кода | MED (DoS на adversarial restore-входе) | Гард `require_fits_input` (array ≥1 байт/эл, map ≥2) в `rscore/crates/runtime/src/codec/storage_msgpack.rs:66,130,140`; коммит `64b41da54` |

## OWNER-DECISION (спека готова, консенсус — нельзя без владельца)

| ID | Баг | Источник | Severity | Статус |
|---|---|---|---|---|
| BUG-05 | **Условная rollback-duplicate находка:** TLA-модель даёт Rust(reject) same-height standoff и TS(continue) orphan pending только после абстрактного `DeliverPartial`. Safety (Agreement/AckDurability) не нарушен. В текущем TS и Rust переход публикуется одной атомарной WAL-границей; сохранение `lastRollbackFrameHash` без победного commit пока не показано | C3 TLA+; `proofs/tla/report.md` прямо оставляет production-достижимость открытой | **UNKNOWN; HIGH если cutpoint достижим** | Сначала C10/crash-cutpoint или доказательство storage mapping. Только при достижимости — решение владельца по кандидату FX-4; до этого нельзя заявлять «баг в обоих движках» |
| BUG-06 | `addHold`/`releaseHold` — расхождение ДВУСТОРОННЕЕ (расширено аудитом kani-adversary A3): (a) TS отвергает любой отрицательный amount, Rust принимает отрицательный, если результат остаётся в диапазоне; (b) TS не имеет uint256-потолка, Rust отвергает > 2^256 | C5 Kani + kani-adversary A3, верифицировано (`hold-utils.ts:10-31` vs `delta.rs:167-190`) | LOW (достижимость (b) астрономическая; (a) —语义-расхождение переходов) | Канонизировать семантику в обоих движках (рекомендация: отрицательный = reject всегда + uint256-потолок везде). ЖДЁТ РЕШЕНИЯ |
| BUG-07 | `event_hash` книги: смешивает только младшие 32 бита цены/qty, LCG mod 2^53; часть book commitment | мой аудит Rust | LOW-MED (коллизии достижимы без злого умысла при price > 2^32 тиков; pages-root пиняет содержимое) | Владелец ruled: координированный protocol/domain bump обоих движков, не сейчас |
| BUG-08 | BatchBounds: worst-case gas 15,049,243 ≥ 15M liveness-бюджета (R2C 4×64) | c4-repro/c4-adversary (пре-существующий, замороженный) | MED (liveness-бюджет on-chain) | Поднять бюджет или оптимизировать путь — решение владельца |
| BUG-13 | Незарегистрированный tokenId (реестр 1..5, протокол ≤65535) с выводимым collateral → `TOKEN_METADATA_UNAVAILABLE` throw внутри Entity commit-границы (`PersistentEntityAccountMap.updated`) — halt всего коммита | C2-hardening (C2-H1), верифицировано (`core/account/utils.ts:209`) | MED (доступность; state валиден по протоколу, но валит границу) | Канонизировать: admission-ограничение зарегистрированными токенами ИЛИ тотальный lookup с default-политикой. ЖДЁТ РЕШЕНИЯ |
| BUG-14 | Конфликтные `cross_pull_lock` (тот же pullId, другие байты) проходят enqueue (fingerprint-дедуп только exact-bytes) → proposal попадает на намеренный `halt_runtime` `CROSS_J_PULL_LOCK_PROPOSAL_FAILED` вместо typed row reject | C2-hardening (C2-H2), верифицировано (`transactions.ts:239`) | MED (доступность, F1-семейство) | Та же политика D4: admission-валидатор конфликтов pullId + drop строки на proposal. ЖДЁТ РЕШЕНИЯ |
| BUG-09 | DebtChunking: тест ожидает очистку 3 долгов одним settlement'ом vs O(1)-дизайн прощения одного cursor-head (Depository.sol:833-858); книги сходятся, деньги целы | переклассифицировано c4-repro, подтверждено мной | INFO (тест-vs-дизайн) | Править ожидание теста или менять дизайн на дренирование (газ-риск) |

## TRIAGE (гигиена, не консенсус)

| ID | Баг | Источник | Severity |
|---|---|---|---|
| BUG-10 | `decode_account_tx` принимает неминимальный BigInt-текст (`"085..."`) — round-trip на экспортируемой границе; конверт spelling-индифферентен | C7 (F1), воспроизведено c7-repro | MED-LOW |
| BUG-11 | `decode_value`/`encode_value` nesting budget off-by-one (глубина 32 декодируется, энкодер +1 отказ) | C7 (F2) | LOW |
| BUG-12 | `read_body_tuple` резервирует `arity×32B` до чтения — public-API футган до ~128MB | C7 (O1) | LOW |

## PARALLEL (закрыты задачами владельца, подтверждено)

- `sync_pair_index` O(N)-rebuild на мутацию ордера; `BookPricePageTree::tail()` линейный скан (мой аудит, Rust-регрессы).
- Re-ACK переподпись → memoized Hanko (D6); `commitment.rs` canonical-переименование (D1).

## НЕ-БАГИ (задокументированные уточнения)

- Conservation in/out безусловен только под covered-transfer precondition (Kani C5).
- Halmos 0.3.3 символьный `gasleft()` → ложная ветка (задокументирована, селектор-толерантность).
- Rollback-duplicate НЕ является bilateral-safety-багом в TLA-модели; liveness/lost-tx
  дефекты условны относительно пока не сопоставленного с production `DeliverPartial`, см. BUG-05.
