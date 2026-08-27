# C2: горячие (мемоизированные) корни ≡ холодный пересчёт после произвольных последовательностей операций

> **Post-fix заметка (2026-08-27, аудит C2-repro):** пин F1 ниже описан как «пинит throw» —
> после посадки FX-3 (решение D4) поведение изменилось: конфликтный j_event_claim получает
> typed reject / drop строки без остановки аккаунта; пин-тест переименован в
> «conflicting j_event_claim is removed without halting» и утверждает разрешение, а не throw.
> Исторические формулировки ниже описывают состояние на SHA dfd45cc7. Открытый хвост FX-3
> на момент аудита: enqueue-level typed reject (`local-tx-admission.ts`) — находка B в
> `proofs/audits/c2-repro/report.md`.

Claim (матрица `proofs/readme.md`, C2): после любой (в пределах модели ниже)
последовательности операций двустороннего Account-консенсуса каждый горячий
(кэшированный/мемоизированный) корень побайтово равен своему холодному оракулу
на обеих репликах. Формулировка без «невозможно»: утверждение покрыто
конечным числом прогонов fast-check и регрессионным корпусом; вне модели
(прочие tx-семейства, multi-signer борды, несколько юрисдикций) — не
проверялось.

## Эвидентность (окружение на момент запуска)

| Параметр | Значение |
|---|---|
| `git rev-parse HEAD` | `dfd45cc7c20f188e3f9c032b7549d3baab52b1de` (пин в readme `80924b0…` устарел: параллельная задача C1 закоммитилась в `main` во время работы) |
| `git status --porcelain \| wc -l` | `313` (незакоммиченные изменения параллельных задач; дерево двигалось во время прогона — см. «Наблюдения») |
| Изменения этой задачи | только 3 новых файла: `core/__tests__/proofs/hot-vs-cold.test.ts`, `core/__tests__/proofs/hot-vs-cold.regression.ts`, `proofs/ts/report.md`; плюс devDependency `fast-check` в `package.json`/`bun.lock`. Продакшн-код не менялся |
| bun | `1.3.14` (JavaScriptCore) |
| fast-check | `4.9.0` (devDependency; API v4: взвешенный `fc.oneof({weight, arbitrary}, …)`) |

## Харнесс: реальные функции консенсуса, без моков

`core/__tests__/proofs/hot-vs-cold.test.ts` строит детерминированный
двухрепличный Account:

- два lazy-Entity (`generateLazyEntityId([signer], 1n)` — self-authenticating
  board, ровно как в проде: `hanko/claims.ts:178` пропускает заявку
  `entityId === boardHash` без реестра), реальные secp256k1-ключи
  (`deriveSignerKeySync`/`registerSignerKey`), RFC 6979-детерминированные
  подписи;
- транзишены исполняют продакшн-функции: `applyAccountInput`
  (`core/account/consensus/index.ts:1208`), `proposeAccountFrame`
  (`core/account/consensus/proposal/propose.ts:160`), реальный
  `verifyHankoForHash` через `createAccountConsensusContext` (никаких
  тестовых верификаторов);
- граница Entity-кадра воспроизведена продакшн-парой:
  `forkAccountReplicaShell` (shell на запись) → операции →
  `PersistentEntityAccountMap.updated` (seal+freeze) — как
  `EntityAccountCandidateMap.getForWrite/sealCandidate` в проде;
- граница подписи-свидетелей воспроизведена по
  `core/entity/consensus/input/hanko-witness.ts`: манифест
  `hashesToSign` подписывается один раз (`signEntityHashes`) при
  сертификации, дальше только переиспользуется (включая bundled-ACK в
  `frame_ack` и кэш `lastOutboundFrameAck` для re-ACK пути);
- граница J-claim узлов воспроизведена по
  `cacheCommittedAccountJClaimNodeChanges` (сессионный overlay → durable
  store при коммите результата).

## Модель операций (bounded)

- ≤ 40 операций на прогон; взвешенный выбор:
  `admit` 22% / `propose` 30% / `deliver` 20% / `ack` 16% / `jclaim` 12%.
- `admit`: 1–5 tx из {`direct_payment`, `set_credit_limit`, `add_delta`},
  tokenId 1–8, amount платежа 0–5000 (0 — ожидаемый typed-отказ, min 1),
  credit limit 0–1 000 000.
- `jclaim`: канонический поток наблюдений — ровно один детерминированный
  `AccountSettled`-ивент на jHeight 1–5 (дубликаты/повторы легальны;
  конфликты исключены из генератора и закреплены отдельным finding-pin).
- `deliver`/`ack` — переиспользуемые доставки (at-least-once): повторные
  доставки породают replay/stale/duplicate-ACK пути; коллизия обеих сторон
  на одной высоте, LEFT-wins тайбрейк, rollback RIGHT с восстановлением
  mempool и последующий re-propose возникают из последовательности
  (см. r2 корпуса).
- Часы детерминированы: `env.state.timestamp += 1000` на операцию;
  никаких `Date.now`/`Math.random` в харнессе.

## Проверяемые утверждения (после КАЖДОЙ операции, обе реплики)

1. `computeAccountStateRoot(state) === computeAccountStateRootCold(state)`
   (+ повторное чтение горячего корня и `peekAccountStateRoot`-мемо,
   если присутствует, против холодного).
2. `computeAccountStateSectionHashes === computeAccountStateSectionHashesCold`
   (все 5 секций).
3. `computeAccountCommitmentSectionDetail === …Cold` (5 корней карт +
   settlementWorkspaceHash).
4. Каждая коллекция состояния (`deltas`, `locks`, `pulls`, `swapOffers`,
   `subcontracts`, `lendingIntents`, `requestedRebalance`,
   `requestedRebalanceFeeState`, `rebalanceFeePolicies`) и конвертные карты
   (`pendingWithdrawals`, shadow-policy, shadow-submitted):
   `rootHash() === coldRootHash()`.
5. `computeCanonicalEntityConsensusStateHash(state) ===
   computeCanonicalEntityConsensusStateHashCold(state)` — покрывает
   транзитивно горячий лист Account (`computeEntityAccountValueHash` vs
   приватный `computeEntityAccountValueHashCold` через rebuild секции
   `accounts`), мемо `hankoLeafDigest`, `mempoolRoot`, биндинги
   `compactAccountInputBindingMemo`/`outboundAckBinding`,
   `entityCollectionCommitment` и `transferAccountStateRootMemo` при
   каждом форке shell.
6. Бесплатные инварианты реплик (fints.md): холодный корень ==
   `currentFrame.accountStateRoot`; `currentFrame.height ==
   currentHeight`; `pendingFrame ⇒ height == currentHeight+1`;
   `mempool ≤ ACCOUNT_MEMPOOL_SIZE`; в покое (нет pending у обеих, высоты
   равны) — `stateHash` кадров и холодные корни реплик совпадают
   (bilateral agreement).

## Точные команды запуска и результаты

```bash
bun add -d fast-check                    # fast-check@4.9.0, devDependency
bun test core/__tests__/proofs/hot-vs-cold.test.ts          # default: 100 runs × 3 seed
XLN_C2_RUNS=300 bun test core/__tests__/proofs/hot-vs-cold.test.ts   # deep run
```

Прогон 1 (default, 100 runs/seed, seeds 42 / 20260826 / 31337):

```
(pass) regression corpus … [505ms]
(pass) FINDING PIN … [97ms]
(pass) fast-check seed 42 … [8363ms]
(pass) fast-check seed 20260826 … [8499ms]
(pass) fast-check seed 31337 … [8368ms]
5 pass, 0 fail, 77 917 expect() calls, 26.55s
```

Прогон 2 (deep, 300 runs/seed, те же seeds):

```
5 pass, 0 fail, 229 999 expect() calls, 79.10s
```

Итого **900 случайных последовательностей** (≤40 операций каждая) +
4 регрессионных корпуса + finding-pin: **0 расхождений hot-vs-cold**.
Каждая последовательность проверяется после каждой операции, т.е.
порядка 22 000+ граничных проверек корней в прогоне 2.

`bun run check`: падает на двух pre-existing ratchet-гейтах
(`ESLINT_DEBT_CHANGED 342→347`, `NON_NULL_ASSERTION_DEBT_CHANGED
183/682→180/671`) — дрейф базлайнов по всему дереву с 313 грязными
файлами параллельных задач; оба новых файла харнесса ESLint-чистые
(`bunx eslint core/__tests__/proofs/*.ts` — 0 замечаний), продакшн-код
задачей не менялся.

## Покрытые hot/cold пары (файл:строка на SHA `dfd45cc7c`)

| # | Горячий путь | Холодный оракул |
|---|---|---|
| P1 | `core/account/commitment/state-root.ts:424` `computeAccountStateRoot` (мемо `accountStateRootMemos`, валидация sameCollections/sameScalarIdentities) | `:500` `computeAccountStateRootCold` |
| P2 | `:237` `computeAccountStateSectionHashes` | `:247` `computeAccountStateSectionHashesCold` |
| P3 | `:289` `computeAccountCommitmentSectionDetail` | `:294` `computeAccountCommitmentSectionDetailCold` |
| P4 | `core/account/state/persistent-state-map.ts:222` `rootHash()` (мемо листьев `leafDigests` + кэш узлов Patricia) | `:227` `coldRootHash()` — для всех 9 карт состояния и 3 конвертных |
| P5 | `core/entity/consensus/state-root.ts:770` `computeCanonicalEntityConsensusStateHash` | `:871` `computeCanonicalEntityConsensusStateHashCold` (секции `:891` `computeEntityConsensusSectionDigestsCold` — тем же равенством) |
| P6 | `:674` `computeEntityAccountValueHash` (горячий лист) | `:695` `computeEntityAccountValueHashCold` (приватный; через rebuild секции accounts в P5) |
| P7 | внутренние мемо листа: `:278` `hankoLeafDigest`, `:383` `mempoolRoot`, `:414` `compactAccountInputBindingMemo`, `:425` `outboundAckBinding` | cold-флаги тех же функций (мимо мемо) |
| P8 | `core/entity/state/persistent-collection-map.ts:98` `rootHash` / `:273` (candidate) | `:101` `coldRootHash` / `:275` — через `entityCollectionCommitment(m, cold)` в P5 |
| P9 | `core/account/commitment/state-root.ts:396` `transferAccountStateRootMemo` (перенос мемо через value-preserving fork) — вызывается реальным `forkAccountReplicaShell` каждую операцию | проверяется неявно: перенос + последующие hot(P1) vs cold |

Ограничение P8: entity-коллекции (`htlcRoutes`, `lockBook`, `crontabState`,
cross-j) в харнессе всегда пустые — их hot/cold проверено только на пустых
картах (равенство тривиально). Непустые значения требуют Entity-tx машин и
остаются за пределами модели.

## Находки (найдено, не исправлено — по правилам readme)

**F1 (единственная содержательная).** Последовательность
`[admit jclaim(jHeight=H, block A)] → propose → deliver → ack →
[admit jclaim(jHeight=H, block B≠A)] → propose` заставляет
`proposeAccountFrame` БРОСАТЬ `ACCOUNT_J_CLAIM_LEFT/RIGHT_CONFLICT`
(`core/account/j-claims/j-claim-transition.ts:86-88`, `assertExactMember`)
вместо typed-отказа `ACCOUNT_TX_VALIDATION`. Найдено fast-check (seed 42,
run 79; seed 31337, run 43), минимизировано вручную до 6 операций, закреплено
тестом `FINDING PIN` в `hot-vs-cold.test.ts` (пинит текущее поведение: throw;
зафиксировано, что до halt закоммиченные корни обоих реплик остаются
hot==cold). Оценка достижимости: локальный enqueue принимает конфликтующий
claim без валидации; вопрос, может ли враждебный PEER-кадр с таким tx
остановить приёмник на replay — оставлен владельцу (replay-путь не ловит
throw). Это не расхождение hot-vs-cold; availability-кандидат.

**Наблюдения (не находки).** Во время прогона дерево активно редактировалось
параллельной задачей: кратковременно наблюдались (а) `cloneIsolatedAccountFrame`
без `stateHash`/`byLeft`/`deltas` (сейчас тип `AccountFrame` в `core/types/account.ts`
уже не содержит `byLeft`/`deltas` — миграция «remove duplicate frame hashing»),
(б) удаление `core/entity/consumption/*` с висячими импортами. Оба состояния
транзиентны; итоговые прогоны выше — на согласовавшемся дереве.

## Калибровка

Список известных багов B1–B8 от владельца не получен; корпус откалиброван на
собственной находке F1 (минимальный кейс в finding-pin). После получения B1–B8
каждый обязан стать обязательным кейсом этого харнесса (правило 4 readme).

---

# Hardening 2026-08-26 (волна закрытия c2-adversary, гэпы A1–A8)

Аудит `proofs/audits/c2-adversary/report.md` (55/100) предъявил 12 пунктов;
ниже — что закрыто в `core/__tests__/proofs/hot-vs-cold.test.ts` +
`hot-vs-cold.regression.ts`, что осталось и что найдено нового.
Продакшн-код не менялся (READ-ONLY для этой волны).

## Эвидентность прогона

| Параметр | Значение |
|---|---|
| `git rev-parse HEAD` при основном прогоне | `d483605e25151709ab09a7e216486b3748887c22` (параллельные задачи коммитились в `main` во время работы; контрольный повтор — на `3cbf807da97c1e5587640727b9cd30724b1e7b1a`, те же 7 pass / 0 fail / 113,872 expects) |
| `git status --porcelain \| wc -l` | 15 на основном прогоне; 72 на контрольном (в т.ч. 4 грязных продакшн-файла `core/entity/consensus/*` параллельной задачи — ни один не входит в импорт-граф харнесса) |
| bun / fast-check | 1.3.14 / 4.9.0 |
| Команды | `bun test core/__tests__/proofs/hot-vs-cold.test.ts` (default 100 runs × 3 seeds) → **7 pass, 0 fail, 113,872 expect() calls, 27–30s**; `XLN_C2_RUNS=300` → **7 pass, 0 fail, 325,793 expect() calls, 79.4s** |
| `bun run check` | падает на одном pre-existing ratchet-гейте `NON_NULL_ASSERTION_DEBT_CHANGED expected=179/649 actual=177/645` — дрейф базлайна по всему дереву от параллельного WIP; проверено stash-контролем: с моими файлами и без них счётчик идентичен (177/645), вклад файлов волны — ноль; ESLint обоих файлов — 0 замечаний |

Состав 7 тестов: regression corpus (9 корпусов + coverage-полы), finding-pin F1,
D4-векторы, pin C2-H2, 3 fast-check сида. Честный учёт последовательностей
(A7): fast-check детерминирован per-seed, поэтому 100-run проход — строгий
префикс 300-run; **различных последовательностей 900**, а не «1,200»
(формулировка выше в историческом разделе — ошибка аудита A7, исправлена здесь).

## Закрытые гэпы

- **A2 (пункты 1–3 списка аудита) — непустые карты + delete-путь.** Генезис
  харнесса инстанцирует все 4 опциональных неймспейса (`pulls`, `subcontracts`,
  `lendingIntents`, `rebalanceFeePolicies`) пустыми персистентными картами;
  `checkAccountRoots` больше не молча пропускает карту — не-персистентная
  коллекция это `HARNESS_COLLECTION_NOT_PERSISTENT` (фейл-фаст). Оп-генератор
  расширен 8 видами tx: `htlc_lock` (обе delivery-моды + без моды),
  `htlc_resolve` (secret — плательщик, error — бенефициар), `swap_offer`,
  `swap_cancel` (= `swap_resolve` fillRatio 0 + cancelRemainder с чужой
  стороны), `cross_pull_lock` (роут+биндинг строятся продакшн-билдерами
  `withCanonicalCrossJurisdictionRouteHash`/`buildCrossJurisdictionPullBinding`),
  `rebalance_policy`, `request_collateral`, `rebalance_refund`. REMOVE-пути на
  непустых деревьях: `locks.del` (resolve secret+error), `swapOffers.del`
  (cancel), `requestedRebalance/.requestedRebalanceFeeState/.shadowSubmitted.del`
  (полный refund + j-finality-очистка при возрастающем collateral события).
  Покрытие измеряется per-run (`nonEmpty`/`shrank`/`opCounts`) и закреплено
  детерминированными полами в corpus-тесте: непусты `deltas, locks, pulls,
  swapOffers, requestedRebalance, requestedRebalanceFeeState,
  rebalanceFeePolicies`; усохли `locks, swapOffers, requestedRebalance,
  requestedRebalanceFeeState`. На 300-run все 3 сида дают те же 7 непустых
  коллекций. DELETE-path (`deleteRadixNode` + branch collapse) теперь гоняется
  на каждом корпусе r5–r7 и в случайных прогонах.
- **A3 (пункт 4) — конфликты снова генерируемы.** Оп `jclaim` несёт
  сгенерированный `blockByte` (0..255): дубликаты и конфликты на одном jHeight
  оба достижимы; конфликт идёт через FX-3 typed-admission reject (харнесс
  проверяет hot==cold после каждого такого шага). Все 4 вектора D4 закреплены
  отдельным тестом в ЭТОМ харнессе (committed conflict — существующий F1-pin;
  два конфликта в одном batch → rejection indexes [0,2]; exact duplicate после
  commit → idempotent skip без rejection-строки; stale admitted claim после
  incoming frame → proposal-window drop `disposition: 'removed'`), с checkAll
  после каждого шага. L1-верблюкты остаются в
  `core/__tests__/account/j-claims/j-claim-admission-vectors.test.ts`.
- **A4 (пункты 5–6) — Entity overlay и leaf-registry.** `exerciseEntityOverlay`
  выполняется 3 раза на каждую последовательность (после генезиса, в середине,
  в конце, обе стороны): leaf-registry remember→peek (равенство digest) и
  fold с remembered-leaf == fold с recomputed-leaf; `EntityAccountCandidateMap`
  hash-проекция (двойное чтение — переиспользование кэша, корень ==
  закоммиченному), multi-account fold (2 грязных листа) seal==rebuild,
  re-seal замороженного листа (`set(committed)`→`getForWrite` → форк, не
  замороженный оригинал), реальный enqueue на форк-шелле +
  `dropCachedProjection` + повторный seal (корень изменился, == rebuild),
  `invalidateEntityAccountCommitment` на закоммиченной и candidate-карте.
  Граница записи (`getForWrite`) забывает engine-leaf (peek → undefined).
- **A5 (пункт 7) — post-finality enforcement clock.** `security(side)` теперь
  берёт `finalizedJHeight` из `account.state.lastFinalizedJHeight ?? 0` — та же
  цепочка резолюции, что в проде (`provided ?? entityClock ?? state ?? 0`).
  Корпус r3 расширен: bilateral finalize на jHeight 3 → нисходящий claim
  (stale-prune) → обычная работа под продвинутыми часами → finalize jHeight 4;
  r7 завершает j-event finalize с очисткой collateral-запроса (del-ветка
  `requestedRebalance`).
- **A6 — граница оракула.** Формулировка свойства (без изменения кода):
  холодные оракулы делят leaf-digest-энкодеры с горячим путём, поэтому
  доказано свойство «корректность инвалидации кэшей узлов и identity-keyed
  мемо», а не «корректность вычисления digest'ов».
- **A7/A8 (пункты 11) — учёт.** 900 различных последовательностей (не 1,200);
  per-op-kind счётчики и множества nonEmpty/shrank печатаются для каждого
  сида; deliver/ack до propose остаются детерминированными no-op (доля
  no-op-шагов не утверждается). F1-pin — **7 операций** (admitClaim, propose,
  deliver, ack, admitClaim(конфликт), admit payment, propose), payment
  load-bearing — комментарий в пине и здесь.
- **A1 (пункт 12) — воспроизводимость.** Артефакты волны коммитятся атомарно
  (только `core/__tests__/proofs/**` + `proofs/ts/**`); SHA/грязь записаны
  выше. Загрузка харнесса на текущем дереве подтверждена контрольным прогоном.

## Новые находки волны (продакшн READ-ONLY — на решение владельца)

- **C2-H1 (availability, env-зависимый halt на Entity-коммит-границе).**
  `add_delta` допускает tokenId до 65535, runtime-registry знает только 1..5
  (`getKnownTokenIds`). Если у аккаунта появляется строка дельты на
  незарегистрированном tokenId с положительным withdrawable collateral
  (например, через `j_event_claim`/AccountSettled — `assertSettlementTokenId`
  допускает ≤65535, или R→C), то `classifyAccountWork → hasRebalanceWork →
  getDefaultRebalancePolicyForToken → getTokenInfo` бросает
  `TOKEN_METADATA_UNAVAILABLE` внутри `PersistentEntityAccountMap.updated()/
  fromEntries` — т.е. любая запись Entity-карты останавливается. Харнесс
  ограничил фондируемый генезис и генератор зарегистрированными id 1..5
  (r4 сохраняет zero-collateral строку на 7 — безвредный случай закреплён).
- **C2-H2 (availability, семейство F1/FX-3).** Локальный enqueue допускает
  два `cross_pull_lock` с одним `pullId`, но разными байтами (fingerprint-dedup
  ловит только точные дубликаты); на proposal второй срабатывает
  `CROSS_J_PULL_LOCK_PROPOSAL_FAILED` (halt_runtime) вместо typed-отказа по
  строке. Найдено расширенным генератором (seed 20260826, 100-run проход).
  В проде pull-ы строит детерминированный Entity command planner, но current
  board может подать AccountTx напрямую (класс полномочий F1). Закреплено
  пином текущего поведения (hot==cold до halt); случайная модель держит
  инвариант планировщика «один живой pull на leg заказа».
- **Исправлен латентный баг генезиса харнесса** (не продакшн): строки 2..N
  копировались со значением `tokenId: 1` внутри дельты → драфты по токену N
  коммитились в строку 1 (наблюдалось как «исчезновение» HTLC-hold). Теперь
  значение несёт свой tokenId.

## Остаточные гэпы (честно)

- `lendingIntents` не наполняется: `lending_*` вне RRS-профиля (FX-2/D3,
  громкий admission reject в обоих движках); `subcontracts`, `pendingWithdrawals`,
  shadow-policy/submitted не имеют in-profile писателя в Account-машине
  (Entity-lifecycle машин вне модели). Их map-level hot==cold проверяется на
  пустых, непустота — за пределами модели.
- `pulls` без delete-пути: `cross_pull_close` требует hash-ladder reveal
  machinery — вне модели этой волны.
- Dispute/`external_finality`/settle_transition input kinds и
  `settlementWorkspaceHash != null` (пункт 8 аудита), двойной rollback
  (пункт 9), мультилистовые `deltas` за пределами 5 зарегистрированных
  токенов + граничные tokenId (пункт 10) — не покрыто.
- Witness-lifecycle (A9: prunинг свидетелей, state-resolution ACK-хэшей)
  по-прежнему вне модели; certify-once/reuse воспроизведён честно.

