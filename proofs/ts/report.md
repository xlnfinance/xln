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
