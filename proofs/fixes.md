# proofs/fixes.md — посадочные спеки решений D2/D3/D4

Статус: спеки готовы к исполнению. НЕ лендить, пока параллельные RRS-задачи держат
целевые файлы грязными (на 2026-08-27: 411 dirty файлов, `core/account/consensus/index.ts`,
`collision.ts`, `frame/hash.ts`, `rscore/.../engine/src/consensus/frame/hash.rs` — в WIP).
Перед применением: проверить `git status` по целевым файлам и `git log` — параллельный WIP
мог уже частично покрыть пункты.

## FX-1 — policyVersion: единый диапазон admission (D2)

Семантика: `RebalancePolicy.policyVersion` допустим только `0..=9_007_199_254_740_991`
(`Number.MAX_SAFE_INTEGER`). Всё вне диапазона — громкий typed reject на admission,
до mempool, в обоих движках. Обоснование: TS-`number` выше 2^53 теряет точность молча —
TS сегодня хеширует искажённое значение; Rust отказывает `UnsafeInteger` — движки расходятся.

Touch points:
- TS admission: ветка enqueue в `core/account/consensus/index.ts` (`applyAccountInput`),
  до записи в mempool; typed rejection по образцу существующих (см. соседние rejects).
- TS хеш-слой (страховка): `core/account/consensus/frame/hash.ts`
  `canonicalAccountTxForFrameHash` — если добрался до хеша вне диапазона, это баг admission:
  бросить, не хешировать.
- Rust admission: `rscore/crates/engine/src/consensus/frame/hash.rs` — расширить
  `is_frame_hashable`-подобную admission-проверку в `AccountConsensus::admit_txs`
  (`engine/src/consensus/replica.rs`): `policy_version > MAX_SAFE` → `UnsupportedFrameTx`-класс
  typed ошибки с точным кодом (новый код ошибки, не переиспользовать чужой).
- Константа одна в каждом движке, значение задокументировать в `docs/fints.md` как диапазон протокола.

Векторы: policyVersion = 0 / MAX / MAX+1 / 2^54 / u64::MAX — verdict-паритет TS↔Rust
(admit reject одинаковой формы).

## FX-2 — lending_* вне профиля: громкий reject в обоих направлениях (D3)

Семантика: `lending_fund | lending_borrow_request | lending_repay | lending_credit |
lending_close_request | lending_close_payout | reserve_to_collateral` — admission
отвергает громко и typed; входящие пейр-фреймы с такими tx — громкий typed reject.
Никакого TS-fallback исполнения. Профиль RRS: pay/HTLC/same-J swap/j-event/rebalance.

Touch points:
- Rust: admission уже отвергает (`is_frame_hashable` + `unsupported_kind`,
  `engine/src/consensus/frame/hash.rs`); входящие фреймы — `canonical_tx_value` Err →
  rejected. Проверить: код ошибки различает «unmodelled kind» явно (читаемое имя вида),
  не generic.
- TS: сегодня допускает и хеширует passthrough — добавить admission-фильтр того же списка
  видов в enqueue-ветку `applyAccountInput`; typed reject; входящее направление — reject
  в preflight до replay.

Векторы: каждый из 7 видов → одинаковый verdict-тип в обоих движках (local admit и
incoming frame).

## FX-3 — F1: общий j-claim validator, отсутствие голых Error (D4)

Семантика (один validator, используемый admission и proposal):
1. exact duplicate (тот же jHeight + тот же jBlockHash + тот же eventsHash) — idempotent:
   admission молча пропускает (не дублирует в mempool), proposal не создаёт вторую запись.
2. конфликт с committed accumulator (та же высота, другой blockHash/eventsHash) —
   admission: typed reject; proposal: drop ТОЛЬКО конфликтной строки с typed disposition
   (аналог `DroppedTx { disposition: Removed }` в Rust), аккаунт продолжается.
3. конфликт с более ранним claim в mempool — admission: typed reject.
4. состояние изменилось после admission (например, incoming frame закоммитил claim) —
   proposal удаляет только конфликтную строку, продолжая окно. Голый `Error`/throw — запрещён.

Touch points:
- TS: `core/account/j-claims/j-claim-transition.ts` — `assertExactMember` (строки 79-122)
  заменить throw на возвращаемый typed-результат; вызывающие ветки admission/proposal;
  enqueue-валидация в `core/account/consensus/index.ts`.
- Rust: `engine/src/consensus/proposal/propose.rs` `prepare_transaction` →
  `prepare_claim_tx` — конфликт классифицировать (не `?`-пробрасывать): в `execute_window`
  конфликтная строка → `dropped.push(DroppedTx { disposition: Removed, rejection: typed })`;
  прочие ошибки store/декодирования — по-прежнему fail-loud `Err`.
  Rust admission (`admit_local_txs` / `AccountConsensus::admit_txs`) — валидатор пунктов 1-3.

Обязательные векторы (все четыре, оба движка, verdict-паритет):
(a) committed conflict; (b) два конфликта в одном batch; (c) exact duplicate;
(d) stale admitted claim после incoming frame.

## Гейты посадки

- L1: узкие тесты на каждый спек-пункт в соответствующем движке.
- L2: TS↔Rust verdict-паритет на всех векторах.
- `bun run check` + соответствующие cargo-тесты — на зелёном дереве (сейчас красный
  от параллельного WIP — не мой долг).
- Коммит: отдельные атомарные коммиты FX-1/FX-2/FX-3; `wip:` префикс если L1/L2 не зелёные.

## FX-4 — каноническая семантика rollback-duplicate (D7-кандидат, ТРЕБУЕТ РЕШЕНИЯ ВЛАДЕЛЬЦА)

Основание: TLA+ вердикт (proofs/tla/report.md, C3) — оба варианта имеют модельно
подтверждённый дефект, safety (Agreement/AckDurability) не нарушен ни одним:

- **reject (Rust)**: CollisionTermination НАРУШЕН — после crash-window
  (post-rollback/pre-commit, `DeliverPartial`) каждый ретрансмит победителя
  отклоняется `ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE` без re-ack, LEFT
  игнорирует фрейм RIGHT → перманентный same-height standoff при полной
  fairness доставки+resend.
- **continue (TS)**: liveness держится, но OrphanPending НАРУШЕН —
  `commitIncomingFrameOnRealState` оставляет same-height pending на месте;
  его восстановленные tx навсегда вне committed ∪ mempool ∪ removed
  (терминальное нарушение NoLostTx).

Предлагаемая каноническая семантика (чинит оба, сводит движки к одному):
1. Ретрансмит победителя с `lastRollbackFrameHash == stateHash`:
   если текущий state уже коммитит этот хеш → re-ack (существующий Duplicate-путь);
2. если коммит не случился (crash-window) → довести коммит победителя И явно
   инвалидировать устаревший same-height pending с восстановлением его tx в
   mempool — никогда не бросать tx и никогда не молчать без re-ack.

Обязательные артефакты: обновлённая TLA-модель с фикс-семантикой (оба свойства
зелёные), TS↔Rust векторы: (a) crash-window ретрансмит; (b) зависший pending;
(c) нормальный duplicate после полного коммита. Storage-аудит вопроса
достижимости окна: может ли `lastRollbackFrameHash` пережить WAL-границу без
победного коммита (NEXT B из tla/report.md).
