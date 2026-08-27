# Аудит координатора доказательной программы xln

Дата: 2026-08-28. Аудированный committed SHA локального `main`:
`b7e3ace82b1c296dff0f646d3bebb120a90a0637`; `origin/main` в момент сверки
отставал на `e69630fca`. Диапазон: `dfd45cc7c..b7e3ace82`.

Режим: чтение committed-байтов через `git show`/`git archive`; только точечные
перезапуски короче двух минут. Proof-only исправления этого аудита лежат поверх
SHA и не являются release evidence до отдельного immutable commit. Параллельный
WIP рабочего дерева исключён из числовых вердиктов.

## Вердикт

**64/100. Программа содержит несколько настоящих и полезных proof-ядер, но не
завершена и пока не поддерживает внешний тезис «вся проверенная оболочка xln
исключает заявленные классы дефектов».** Основные причины: C8 отсутствует как
proof, C9/C10 не выполнены, C3 не сопоставлен с production crash semantics,
C7 покрывает только wave-1, у C5/C6 нет repro-аудита, а несколько
headline-формулировок и audit provenance были неверны.

После этого аудита матрица, первичные C1/C3/C4/C5/C6/C7 отчёты, bug register и
gap register сужены до фактически доказанного scope. Production/consensus/
Solidity не менялись.

## A. Независимые перепрогоны

| Проверка | Чистый subject | Результат | Вердикт |
|---|---|---|---|
| C1, committed 200 + seeds 20260826/777/31337 + numbers 424242 | clean immutable `b7e3ace82`, без overlay | **80,656**, 0 failures; primary 9,353 encode / 752 both-reject / 6 Rust-reject / 3 TS-only | подтверждено после фикса генератора; independent post-FX repro ещё нужен |
| TLC `BC-continue-CrashFALSE` | clean `78e07d9a9`; TLA bytes неизменны до audited SHA | 1,324,097 generated / **337,955 distinct**, depth 22, no error, ~100 s | число отчёта подтверждено |
| Halmos, 5 lemma filters | clean `78e07d9a9`; contracts/artifacts/frozen bytes неизменны до audited SHA | **5/5 pass**, paths 97/948/4/17/2, solver 10.75 s после compile | вердикт подтвержден; path drift допустим |

Дополнительная узкая проверка фиксов: TS FX-1/FX-2 — **18/18**; Rust FX-1/FX-2
— **7/7**; Rust FX-3 — **5/5** на clean `e69630fca`.

Release-gate snapshot рабочего дерева:

- `bun run check` дошёл через BrainVault **26/26** и contract artifact sync без
  diff, затем остановился на `ESLINT_DEBT_CHANGED`: expected 341 /
  `4d3aa9…`, actual 343 / `160d99…`. Proof-only diff ESLint debt не меняет.
- `check:english-source` красный на русских `proofs/**` — ожидаемая English-wave
  действительно не выполнена.
- `check:folder-width` зелёный: `FOLDER_WIDTH_OK dirs=7022 sourceFiles=3738
  max=10/10`; grandfathered debt — `jurisdictions/contracts:16,scripts/dev:12`,
  не `test/foundry`.
- `check:audit-registry` зелёный: registry 17 modules / 26 invariants / 55
  evidence / 17 findings / 39 agents; **16/16** release-integrity tests pass.

## B–E. Находки

### MEDIUM — audit inventory полон по количеству, но provenance неоднороден

- В audited SHA есть **9** пакетов: C1-repro использует нестандартное имя
  `findings.md`, остальные — `report.md`. Исторический C1-repro 92/100 реально
  повторил 80,656/0 на clean `dfd45cc7c`: `proofs/audits/c1-repro/findings.md:31-47`.
- Оригинальный C2-repro 88/100 был потерян до commit; `b043199fe` добавил новый
  независимый replacement 91/100. См. `proofs/audits/c2-repro/report.md:3-9`.
- Количество 9 теперь верно, но требование «по два аудита на свойство» всё ещё не
  выполнено: C3 — 0/2, C5/C6 — без repro, C8 — без proof и аудитов. C1 требует
  повторного repro на post-FX generator bytes.
- Примечание аудитора: ранний черновик ошибочно искал только `report.md` и пропустил
  C1 `findings.md`; финальный inventory пересчитан по всем файлам/каталогам.

### HIGH — C8 не является доказательством эквивалентности движков

- `proofs/readme.md:35` раньше подменял machine-checked equivalence ссылкой на
  «существующие parity-дайджесты». Нет собственного report, immutable subject,
  точной transition relation, cardinality, shrinker и двух аудитов.
- Наличие parity-тестов — хорошая база, но не доказательство C8. Статус исправлен
  на `❌ не доказано как C8`.

### HIGH — BUG-05 был повышен из условного TLA-контрпримера до production bug

- Сам TLA-report оставляет reachability открытой:
  `proofs/tla/report.md:182-185`. Контрпример требует абстрактный
  `DeliverPartial`.
- TS делает rollback и winning commit внутри одного Account transition:
  `core/account/consensus/index.ts:906-916`; authoritative WAL имеет один commit
  point: `core/storage/index.ts:1618-1620`.
- Rust сначала полностью применяет/project'ит переход, затем вызывает один
  durable append: `rscore/crates/runtime/src/processor/durable.rs:288-315`; frame,
  outbox, checkpoint и HEAD входят в один synced batch:
  `rscore/crates/runtime/src/storage/native/store.rs:332-360`.
- Вердикт: **UNKNOWN; HIGH только если C10 найдёт реальный cutpoint**. Формулировки
  исправлены в `proofs/tla/report.md:166-173`, `proofs/bugs.md:20` и
  `proofs/fixes.md:84-116`. Консенсус не менялся.

### HIGH — диапазон коммитов не является изолированным proof-program diff

- Диапазон содержит **38 commits / 832 files / +96,740 −21,940**; только 17
  коммитов касаются `proofs/**`. Вне `proofs/**`: **596 files / +79,574 −21,730**.
- `64b41da54` (к которому приписаны BUG-01/02/04) — 499 файлов,
  +60,087/−11,862; это не атомарный fix commit. `ce14727c8` смешивает 56 proof
  файлов с 14 non-proof; `e69630fca` — явный WIP на 59 Rust-файлов,
  +2,146/−10,236.
- Нельзя доказать авторство «чужого WIP» из Git, но можно доказать отсутствие
  bounded/atomic provenance. Для внешнего пакета нужны fix-manifest или чистые
  cherry-pickable commits с точными file lists и gates.

### MEDIUM — C1 single-source corpus был сломан после FX-1

- Committed seed был вручную переименован в `both-reject`, но генератор продолжал
  создавать `rust-rejects`; clean primary run дал 1 failure из 10,114.
- Root cause: `proofs/fuzz/enc-diff/generate.ts:521-526`. Фикс закоммичен
  `935020a41`; полный 80,656 run на clean `b7e3ace82` зелёный. До нового
  независимого repro-аудита это не финальное release evidence.
- Остатки c1-adversary F2–F7: driver-fabricated duplicate rejection, broken
  content shrinker, неполная validation-asymmetry family, 3/14 TS-only kinds,
  unstable duplicate-path ordering, edge seeds и coverage ledger. См.
  `proofs/audits/c1-adversary/report.md:154-182`.

### MEDIUM — C2 hardening не закрыл весь scope

- Реальный deep run и replacement repro подтверждают **900 sequences / 325,793
  checks**, не исторические 1,200/229,999.
- Остались empty-only namespaces, no pull delete, dispute/external-finality/
  settlement workspace, double rollback, boundary tokenIds и witness lifecycle:
  `proofs/ts/report.md:306-320`.
- Старое «все A-gap'ы закрыты» было ложным; матрица и D4 исправлены. Replacement
  C2-repro 91/100 сам требует fresh seed и не может восстановить pre-FX throw:
  `proofs/audits/c2-repro/report.md:51-73`.

### MEDIUM — C4 scope closure был шире тестов

- 99 pass + 2 известных fail и Halmos 5/5 — реальные. Frozen core подтверждён:
  diff от `80924b035` пуст для contracts/artifacts/typechain/frozen manifest;
  SHA-256 `frozen-core.json` одинаков: `6cb53e910579...e9e`.
- A4 закрыт частично: multi-index/fault/decoder есть, но multi-clause chaining и
  invalid allowance arrays отсутствуют. Сам Halmos harness запрещает переносить
  tolerance на multi-clause: `jurisdictions/test/foundry/HalmosLemmas.t.sol:243-248`.
- A8–A12 остаются: full-int256/sentinel/non-representable/allowance-validity,
  deep/registered/previous-board Hanko, historical replay/deep profile,
  fee-on-transfer и `watchtowerCounterDispute`. Исправлено в
  `proofs/solidity/report.md:96-104` и `proofs/gaps.md`.

### MEDIUM — Kani headline содержал четыре проверяемые ошибки

- W256 sample не достигал rejection boundary; «3 мутанта» были 2 мутанта +
  coverage sensor; subset-order = 73, не 60; production `make_branch` sites = 11,
  не 12. `Rust stricter` для hold был неверен: divergence двусторонний.
- Первичные строки исправлены: `proofs/kani/report.md:69-75`, `:128-133`,
  `:153-156`, `:192-201`. Kani core остаётся содержательным, но bounded, а W256
  rejection и independent repro остаются OPEN.

### MEDIUM — C7 был правильно сужен, но wave-2 не заменена scaffold'ом

- Доказано только 7 targets / 5 crates / 57.6M executions; не «все парсеры».
  Scope теперь прямо записан в `proofs/fuzz/parser/report.md:3-12`.
- Runtime storage/WAL/J-watcher scaffolding без long run/report/audits не является
  evidence. Открыты также checkpoint property, fuzz-earned orderbook acceptance,
  tight budget Pass B, narrow F1 skip, deeper generators и missing decoder surfaces.

### LOW — bug register

- BUG-01/02: код и узкие TS/Rust tests подтверждают единый admission reject;
  `core/account/tx/admission-policy.ts:16-36,72-109`,
  `core/account/input/local-tx-admission.ts:92-108`.
- BUG-03: общий planner и row-level conflict существуют:
  `core/account/j-claims/j-claim-transition.ts:127-178`; 5 Rust vectors зелёные.
  BUG-04 guard существует до allocation:
  `rscore/crates/runtime/src/codec/storage_msgpack.rs:59-73,129-141`, но отдельной
  narrow regression в модуле нет — её должна закрепить C7 wave-2 corpus.
- BUG-06 подтверждён (`core/account/tx/hold-utils.ts:9-45` vs
  `rscore/crates/engine/src/state/delta.rs:167-192`). BUG-13 подтверждён
  `core/account/utils.ts:206-211` → `core/entity/account/account-work-flags.ts:35-43`
  → `core/entity/state/persistent-account-map.ts:162-168`. BUG-14 подтверждён:
  exact-byte dedup only `core/account/input/local-tx-admission.ts:37-54`, затем
  hard halt `core/account/consensus/proposal/transactions.ts:238-240`.

## Потерянные требования аудитов

Единый регистр теперь находится в `proofs/gaps.md`. При сверке обнаружены и
исправлены две потери самого регистра: отсутствовали residual items replacement
C2-repro, а весь C4-A4 ошибочно был помечен CLOSED вместо PARTIAL.

Критические OPEN-группы:

1. C1: post-FX repro + F2–F7 и shrinker calibration.
2. C2: adversary #8–10/A9 + fresh-seed repro.
3. C4: A4 remainder, A8–A12, historical/deep run, BUG-08 owner decision.
4. C5/C6: W256 rejection, callback caveat, independent Kani repro.
5. C7: adversary wave-2 и полный 7/7 repro с сохраняемыми logs/coverage.

## F. Достаточность остаточного плана

Только TLA×2, Kani-repro, C7 wave-2 и English-волна **недостаточны**. Для статуса
«программа завершена» дополнительно обязательны:

1. C1 independent repro на immutable generator-fix SHA и закрытие semantic/
   shrinker gaps; C2 residual coverage или явное bounded исключение.
2. Полноценный C8 transition-equivalence package; затем C9 trace refinement с
   per-frame roots/events/effects/outbox и автоматическим shrink.
3. C10 на реальных TS/Rust durability seams. Именно он должен закрыть или
   подтвердить BUG-05 до любого consensus change.
4. C4 multi-clause/invalid-allowance + full-domain Halmos/другая формализация,
   Hanko grace/registered-board и finalize-capable entrypoints.
5. Один clean immutable release SHA: все reports с subject hashes, два аудита на
   тот же SHA, English-source и `bun run check`; folder-width уже green. Приложить
   final claim-evidence-risk table и manifest смешанных BUG fix commits.

## Ошибки координатора

1. Исходный C2-repro был потерян до commit и потребовал replacement; C1-repro
   нарушает единую дисциплину имени (`findings.md` вместо `report.md`).
2. C1 seed изменён без изменения единственного генератора, что делало официальный
   clean run красным.
3. C2 «все gap'ы закрыты», C4 «scope закрыт», C8 «уже есть» и BUG-05 «два
   production бага» были шире доказательства.
4. Числа Kani (3/60/12 и W256 rejection) остались неверными в headline после
   того, как собственный adversary-аудит уже их опроверг.
5. Proof/fix provenance смешан с крупными WIP-коммитами; финальный пакет не был
   собран на одном clean SHA. `bun run check` теперь предъявлен, но красный на
   изменившемся ESLint debt baseline.

## Что нужно для 100/100

- Обнулить или получить явное owner disposition по каждому OPEN в
  `proofs/gaps.md`; HIGH/MED нельзя закрывать одной переформулировкой, если claim
  остаётся широким.
- Довести C1–C10 до схемы: proof → adversary → repro, все три на идентичных bytes.
- Добавить machine-readable manifest: claim, exact SHA, command, tool hashes,
  bounds/cardinality, expected digest, result, audit SHA, residual risk.
- Запустить release gates один раз на неизменном clean candidate и приложить
  полный вывод/логи; затем запретить дальнейшие WIP-коммиты в audited range.
