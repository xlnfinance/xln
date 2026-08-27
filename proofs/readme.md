# proofs/ — формальные доказательства и доказательный фаззинг

Матрица повторно сверена на `b043199fee93e0e50fb12dcc4cc2b00c7e193fc2`.
Каждый evidence-report обязан указывать собственный immutable SHA, версии инструментов,
точные команды и bounded-скоуп. Результат из dirty worktree не считается доказательством:
повторный прогон выполняется из `git archive` заявленного SHA или другого чистого checkout.

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
| C1 | Канонические энкодеры TS↔Rust дают одинаковые байты либо одинаково отвергают вход в сгенерированном домене | `proofs/fuzz/enc-diff/report.md`: 80,656 кейсов, 0 неожиданных расхождений. Committed adversary: 74/100; заявленный c1-repro 92/100 отсутствует в audited SHA. После FX-1 основной корпус требует новую immutable фиксацию: `tx-policy-unsafe-version` теперь `both-reject`; остаются F2–F7 adversary-gap'ы | ⚠️ bounded evidence; missing repro + re-audit после фикса генератора |
| C2 | Hot-root равен cold-recompute после покрытых последовательностей мутаций | `core/__tests__/proofs/hot-vs-cold.test.ts` + `proofs/ts/report.md`: после hardening 900 последовательностей, 325,793 deep-проверки. Остатки: пустые `lendingIntents`/`subcontracts`/`pendingWithdrawals`/shadow maps, нет delete для pulls, settlement/dispute/external-finality, double rollback и boundary tokenIds. **c2-repro**: исходный отчёт 2026-08-27 утерян до коммита; заменён независимым re-audit `b043199fe` (**91/100**): clean-extraction `78e07d9a9` — 113,872 default / 325,793 deep, точно; гэпы — `proofs/gaps.md` | ⚠️ сильное bounded evidence, не закрыто |
| C3 | В TLA-модели Agreement/AckDurability сохраняются; rollback-duplicate варианты нарушают разные liveness-свойства при `DeliverPartial` | `proofs/tla/report.md`: 8 TLC-прогонов; один прогон независимо повторён: 337,955 distinct states, без ошибки. Производственная достижимость `DeliverPartial` не доказана: TS и Rust публикуют переход через атомарную WAL-границу | ⚠️ модель завершена; 0/2 аудита и нужен crash-cutpoint |
| C4 | Контрактные свойства в пределах Foundry/Halmos моделей | `proofs/solidity/report.md`: 99 pass + 2 известные fail; Halmos 5/5 независимо повторён. `jurisdictions/contracts/**`, artifacts/typechain и `frozen-core.json` не менялись относительно frozen baseline. Hardening закрыл A1–A3/A5–A7; A4 закрыт частично, A8–A12 остаются | ⚠️ воспроизводимо, scope не закрыт |
| C5 | Bounded delta-mirror: арифметика и инварианты 16/8; sampled bridge к production 256/128 | `proofs/kani/report.md`: 16/16 Kani VERIFIED, 2M random + 500k walks + 15,987 boundary + 200k engine cross-check. W256 rejection-ветка фактически не достигается; калибровка — 2 мутанта + 1 coverage sensor, не 3 мутанта | ⚠️ bounded evidence; repro-аудит отсутствует |
| C6 | Radix path-independence/round-trip/injectivity в конечной 4-key вселенной | `proofs/kani/report.md`: 24 перестановки, 73 канонических subset-порядка, 16×15 ordered root pairs; `hash_branch16([])` — ручной census 11 production call sites, не machine proof | ✅ bounded exhaustive; Kani-repro всё ещё нужен |
| C7 | Семь parser targets в пяти крейтах не паникуют/OOM в выполненной wave-1 | `proofs/fuzz/parser/report.md`: 57.6M исполнений, 0 panic/OOM в покрытом. Оценка adversary: 61/100 для исходного «все», 84/100 для узкого scope. Runtime-декодеры, checkpoint/orderbook assertions и wave-2 long run не завершены | ⚠️ только wave-1 scope |
| C8 | Machine-checked TS↔Rust transition equivalence | В репозитории есть parity-дайджесты и тест-векторы, но нет отдельного report с SHA, командами, cardinality, exact transition claim и двумя аудитами | ❌ не доказано как C8 |
| C9 | Trace refinement: одна последовательность inputs → равные roots/events/effects/outbox после каждого перехода, с авто-shrink | фаза 2 (строится на генераторах задачи 1) | ожидает |
| C10 | Crash-cutpoint: восстановление после искуственного краха на каждой границе WAL→fsync→projection→outbox ≡ побитово uninterrupted run | фаза 2; расширяет `core/__tests__/storage/recovery/recovery-outbox-equivalence.test.ts` | ожидает |

## Completion gate

- Под `proofs/audits/` закоммичено **8**, а не 9 пакетов (7 исходных + c2-repro re-audit
  `b043199fe`, заменяющий утерянный до коммита оригинал); заявленный C1-repro отсутствует.
  Аудиты садились в git позже
  пинов своих evidence (`9aa5affbe`/`3cbf807da`) — при цитировании сверять SHA отчёта,
  не только SHA evidence. Отсутствуют: TLA×2 и Kani-repro.
- Единый реестр требований аудитов (до 100/100) — `proofs/gaps.md`; статус «программа
  завершена» требует его обнуления или явного owner-решения по каждому OPEN.
- До статуса «программа завершена» обязательны: полноценный C8, C9/C10, production
  crash-cutpoint для C3/BUG-05, C7 wave-2 и Kani W256 rejection/repro.
- Итоговые числа должны быть исправлены в первичных секциях отчётов, а не только в поздних
  примечаниях, и повторены двумя независимыми аудитами на одном immutable SHA.
- Релизный пакет требует clean SHA, English-источников, folder-width gate, `bun run check`
  и итоговой таблицы claim → proof → adversary → repro → residual risk.

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
  duplicate, stale admitted claim после incoming frame. → `proofs/fixes.md` FX-3. **Hardening посажен**
  (`b8004d939`): 7 коллекций непустые, delete-пути, конфликты и D4-векторы закреплены,
  entity-overlay слой, 325,793 deep-проверки. Остаточный скоуп перечислен в
  `proofs/ts/report.md`; replacement C2-repro — `b043199fe`, 91/100.
  Найдены BUG-13/BUG-14 (см. bugs.md).
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
TS `core/account/consensus/incoming/collision.ts:198` → `return undefined` (продолжить),
Rust `engine/src/consensus/incoming/apply.rs:707` → `rejected("ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE")`
(строки — HEAD `b043199fe`; на TLA-пине `13f51950a` — `:196`/`:652`, см. `proofs/tla/report.md`).
Модель обязана закодировать оба варианта (`TS_ROLLBACK_DUP == continue | reject`) и проверить,
ломает ли расхождение Agreement. Окно достижимости узкое (post-rollback/pre-commit + retry);
если достижимо — Rust-путь может подавлять нужный re-ack → liveness. Это не «расхождение
паритета», а кандидат в баги с приоритетом.
