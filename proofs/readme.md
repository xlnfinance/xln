# proofs/ — формальные доказательства и доказательный фаззинг

Pinned SHA: `80924b035f363d4ad8f4a8c08e6f39dcc7736a78` (рабочее дерево содержит незакоммиченные
изменения параллельных задач; каждый report обязан записать фактический `git rev-parse HEAD`
и `git status --porcelain | wc -l` на момент запуска).

## Правила для всех задач

1. **Продакшн-код не меняется.** Запрещены правки `core/**`, `rscore/crates/**/src/**`,
   `jurisdictions/contracts/**` (frozen-core). Разрешено: новые файлы в `proofs/**`,
   новые тестовые файлы в родных тестовых директориях, devDependencies (fast-check),
   новые standalone-крейты в `proofs/**` с path-зависимостями на rscore.
2. **Дисциплина утверждений.** Каждый report содержит: SHA, версии инструментов, точные команды
   запуска, bounded-допущения (диапазоны/глубины/размеры), точную формулировку доказанного
   свойства. Запрещено слово «невозможно» для конечных моделей — только «в пределах модели X».
3. **Векторы не пишутся руками.** Парity-корпус генерируется из одного источника и
   коммитится как артефакт.
4. **Калибровка.** Харнесс, не воспроизводящий известный баг, считается некалиброванным:
   при появлении известного бага он обязан стать регрессион-кейсом своего харнесса.
   (Владелец 2026-08-27: внешние списки B1–B8 в контексте не определены — не ждать и не выдумывать;
   самокалибровка саботаж-тестами уже применена в C1/C2.)

## Claim / Evidence матрица

| # | Claim (что утверждаем) | Evidence (артефакт) | Статус |
|---|---|---|---|
| C1 | Канонические энкодеры TS↔Rust побайтово эквивалентны на случайных и острых входах | `proofs/fuzz/enc-diff/report.md`: 80,656 кейсов, 0 расхождений. **Аудиты**: c1-repro **92/100** — полное точное воспроизведение на пине dfd45cc7 (таллие байт-в-байт, детерминизм, провенанс-гигиена); обе boundary-находки подтверждены обеими сторонами и закрыты FX-1/FX-2 (policyVersion: TS молча искажал — 2^53 и 2^53+1 в одинаковые байты). c1-adversary **74/100** — метод валиден на общем домене, но: асимметрийное семейство протестировано в одной точке (F2), both-reject для дубликатов — фабрикация тест-драйвера, продакшн-TS-энкодер так не проверяет (F3), шринкер сломан для контентных расхождений (F4), 3/14 TS-only видов (F6), живой корпус 199/200 после FX-1 — метка класса устарела (переименовать). → gap-лист в audits/c1-adversary/report.md | ✅ доказано и воспроизведено; скоуп-гэпы — в волне закрытия |
| C2 | Горячие (мемоизированные) корни ≡ холодному пересчёту после любой последовательности операций | `core/__tests__/proofs/hot-vs-cold.test.ts` + `proofs/ts/report.md`: 1,200 последовательностей, 229,999 expects, hot==cold везде; F1 — конфликтный j_event_claim валит propose throw'ом вместо typed rejection (admission не валидирует) — на решении владельца | ✅ готово |
| C3 | Bilateral account consensus: agreement / ACK-durability / no-lost-tx / collision termination / restore=no-op | `proofs/tla/report.md`: 8 TLC-прогонов (337–372k состояний), TLC 1.8.0. **Вердикт**: Agreement/AckDurability НЕ нарушены ни одним вариантом rollback-duplicate; **reject (Rust) — CollisionTermination НАРУШЕН** (перманентный same-height standoff после crash-window ретрансмита при полной fairness); **continue (TS) — OrphanPending НАРУШЕН** (зависший pending вне committed∪mempool∪removed, терминальный NoLostTx); окно недостижимо без crash-действия, достижимо с ним (witness depth-9). Фикс-семантика → `proofs/fixes.md` FX-4, требует решения владельца | ✅ доказательство завершено; найдены 2 бага (по одному на движок) |
| C4 | Контракты: conservation стоимости, transformer allowances, nonce-монотонность, Hanko-порог | `proofs/solidity/report.md` + `jurisdictions/test/foundry/*` (35 тестов) + Halmos 5/5; багов в целях 1–5 не найдено; 2 пре-существующих падения замороженных тестов на триаже (DebtChunking = тест-vs-O(1)-дизайн, книги сходятся — проверено; BatchBounds gas ≥15M). **Аудиты**: c4-repro 92/100 (воспроизведение полное, провенанс закрыт git-archive пина); c4-adversary **78/100 по скоупу** — HIGH: долговой жизненный цикл недостижим в conservation-модели (споры не генерируются, forgive всегда пуст — верифицировано независимо), transformer только single-index/single-clause без adversarial fault-модей, hash-ladder симметричные окна. → C4-hardening wave-2: **посажено** (`aecfed195`) — долговой цикл генерируется (disputes/enforce/непустое прощение), debt-гост-инварианты, 6 fault-модей fail-closed, асимметричные окна 50/70, repay-действие; 99 pass + halmos 5/5, frozen-core UNCHANGED | ✅ воспроизводимо + скоуп закрыт |
| C5 | Дельта-математика: flip-инволюция, capacity ≥ 0, transfer-консервация, hold∘release=id, диапазоны полей | `proofs/kani/report.md` (коммит 6ee90c875): **16/16 Kani-харнессов VERIFIED** + мост эквивалентности (2M случайных, 500k walks, 15,987 граничных, **200k кросс-чек против реального движка на ширине 256/128**, 3-мутантная калибровка, корпус закоммичен). Уточнение: conservation in/out безусловен только под production-precondition covered-transfer (клэмп-дефицит снаружи) | ✅ доказано |
| C6 | Radix: path-independence корня, delete∘insert=id, структурная инъективность (2-байтовые ключи, ≤4 листа) | `proofs/kani/report.md`: **полный перебор вселенной 4-key/2-byte** (24/24 перестановок — один корень; 60/60 канонических порядков; 16×15 пар — различные реальные SHA-256 корни; round-trips; delete∘insert=id уточнён — для отсутствующего ключа). Символьный Kani не сходится на aarch64 (задокументировано: Arc drop-glue × 16-ary × SHA unwind ≥75) — харнессы остались под мощнее раннер. `hash_branch16([])`-недостижимость — 12-сайтовый census | ✅ доказано (bounded exhaustive) |
| C7 | Все парсеры: no panic/OOM, budget срабатывает раньше аллокации, каноничность принимается только байт-в-байт | `proofs/fuzz/parser/report.md`: 57.6M исполнений, **7 таргетов в 5 крейтах (abi/hanko/process/entity-kernel/protocol)**, 0 паник/OOM в покрытом; F1/F2/O1 на триаже. **Скоуп-уточнение аудита c7-adversary (61/100 как «все», 84/100 в покрытом)**: крейт `runtime` НЕ покрыт (storage_msgpack, account_input_json, restore-декодеры, j_watcher/abi, wal_input); A2 — OOM-амплификация `with_capacity` в storage_msgpack подтверждена и закрыта гардом `require_fits_input` (файл — WIP параллельной задачи, коммит за ней); wave-2: фаззинг runtime-декодеров + усиление ассертов checkpoint_wire/orderbook | ✅ в покрытом скоупе; расширение — wave-2 |
| C8 | Эквивалентность движков TS↔Rust (машинная) | Существующие parity-дайджесты + тест-векторы в репо | уже есть; задокументировано здесь |
| C9 | Trace refinement: одна последовательность inputs → равные roots/events/effects/outbox после каждого перехода, с авто-shrink | фаза 2 (строится на генераторах задачи 1) | ожидает |
| C10 | Crash-cutpoint: восстановление после искуственного краха на каждой границе WAL→fsync→projection→outbox ≡ побитово uninterrupted run | фаза 2; расширяет `core/__tests__/storage/recovery/recovery-outbox-equivalence.test.ts` | ожидает |

## Точные формулировки кодек-свойств (для задач 1, 6, 7)

- `decode(encode(x)) = normalize(x)`
- `encode(decode(canonicalBytes)) = canonicalBytes`
- Любой принятый wire-input обязан быть каноническим (re-encode = вход).
- Любой rejected input не меняет состояние декодера/реплики.

Острые края генератора (обязательные seed'ы): суррогатные пары/не-BMP (cmp_utf16 vs JS `<`),
`ryu_js` round-trip и границы JS_MAX_SAFE_INTEGER, `-0`, `1e21`, нулевой BigInt (`[0]` magnitude),
пустые Array/Set/Map, дубли ключей (обе стороны обязаны отказаться), строки ровно 55/56 байт
(RLP-граница).

## Журнал решений владельца (2026-08-27)

- **D1** `entity-kernel/commitment.rs` — канонический authoritative RRS-код; комментарий и имя
  `with_diagnostic_commitments` исправлены на canonical. Закрыто.
- **D2** `policyVersion` — единый диапазон обоих движков `0..Number.MAX_SAFE_INTEGER`
  (9_007_199_254_740_991); TS и Rust отвергают большее на admission до mempool. Полный u64
  в одном Rust — только с protocol bump. → `proofs/fixes.md` FX-1.
- **D3** `lending_*`/`reserve_to_collateral` — вне RRS-профиля (профиль: pay/HTLC/same-J swap/
  j-event/rebalance). Громкий admission reject в обоих направлениях, без TS fallback. → FX-2.
- **D4** F1 j-claim — один общий validator для admission и proposal; exact duplicate —
  idempotent; конфликт с committed/ранним mempool claim — typed reject; proposal удаляет только
  конфликтную строку с typed disposition и продолжает аккаунт, никогда голый `Error`.
  Обязательные векторы TS↔Rust: committed conflict, два конфликта в одном batch, exact
  duplicate, stale admitted claim после incoming frame. → `proofs/fixes.md` FX-3. **Hardening посажен** (`b8004d939`): все A-гэпы закрыты — 7 коллекций непустые, delete-пути, конфликты генерируются + D4-векторы закреплены, entity-overlay слой, 325,793 expects deep; новые находки BUG-13/BUG-14 (см. bugs.md). Ревизионная переоценка аудита — опционально.
- **D5** Удаление legacy wave/shadow/worker — атомарно после exact RRS replay + crash restore
  TS↔Rust + pay/same-J HLT. Не трогать до гейтов.
- **D6** Re-ACK — переиспользование сохранённого Hanko без новой ECDSA; current/previous-board
  grace; missing/corrupt cache — громкий отказ. Исправляется параллельной задачей.
- **Freeze**: новые формальные направления не открываются; критический путь — exact RRS.
  Текущие задачи (TLA/foundry/Kani) завершаются.



1. Differential encoder fuzz (фундамент под всеми корнями) — без нового тулчейна.
2. Hot-vs-cold свойства — без нового тулчейна.
3. TLA+ bilateral — узкая машина, не каскад.
4. Foundry инварианты — conservation/allowances/nonce/hanko.
5. Kani (зеркало дельт + bounded radix) — последним из «формальных».

Kani-ограничение: никаких заявлений про BigInt/SHA/ECDSA/всю машину — только bounded
fixed-width арифметика, overflow, routing и малые reducers.

## Отклонено/отложено

- **Loom** — отклонено: loom верифицирует атомики/порядки памяти малых lock-free структур;
  синхронизация resident-леса — Barrier+AtomicBool с простым протоколом фаз, не loom-масштаб.
  Протокольные свойства фаз покрываются TLA+ (фаза 2, опционально).
- **Certora** — отложено (нет лицензии); foundry-invariants даёт ~70% того же за 0 лицензий.
- **CI-гейт** (изменение `core/account/consensus/**` или `rscore/crates/engine/src/consensus/**`
  без зелёного TLC = красный) — предложен, включение требует решения владельца.

## Известное расхождение для TLA-вариантов (проверено по коду)

`rollback-duplicate` (ретрансмит победившего фрейма после роллбэка):
TS `core/account/consensus/incoming/collision.ts:196` → `return undefined` (продолжить),
Rust `engine/src/consensus/incoming/apply.rs` → `rejected("ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE")`.
Модель обязана закодировать оба варианта (`TS_ROLLBACK_DUP == continue | reject`) и проверить,
ломает ли расхождение Agreement. Окно достижимости узкое (post-rollback/pre-commit + retry);
если достижимо — Rust-путь может подавлять нужный re-ack → liveness. Это не «расхождение
паритета», а кандидат в баги с приоритетом.
