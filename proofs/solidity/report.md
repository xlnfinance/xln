# C4: Foundry-инварианты + Halmos на денежных контрактах `jurisdictions/`

Claim (матрица `proofs/readme.md`, C4): conservation стоимости, transformer
allowances, nonce-монотонность и Hanko-порог держатся на текущем байткоде
`Depository`/`Account`/`HankoVerifier`/`HashLadderRegistry` — в пределах моделей,
описанных ниже. Без слова «невозможно»: каждое утверждение ограничено
перечисленными доменами, границами и глубиной фазза/символьного исполнения.

## Эвидентность (окружение на момент запуска)

| Параметр | Значение |
|---|---|
| pinned SHA (readme) | `80924b035f363d4ad8f4a8c08e6f39dcc7736a78` |
| `git rev-parse HEAD` (финальные прогоны) | `b95e7ee3b6345a296535aeb6a5d375efc1a27c88` (HEAD сместился параллельными задачами; контрактный код между прогонами не менялся — см. ниже) |
| `git status --porcelain \| wc -l` | `411` на момент финального прогона; изменения этой задачи — ровно 10 новых неотслеживаемых файлов в `jurisdictions/test/foundry/` + симлинк `jurisdictions/out -> forge-out` |
| frozen-core | `git status --porcelain -- jurisdictions/contracts/` → пусто: ни один контракт не изменён; правки только НОВЫЕ файлы в `jurisdictions/test/` |
| forge | `1.7.1` (commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`) |
| solc | `0.8.36` (via_ir=true, optimizer_runs=1, evm=cancun — из `foundry.toml`) |
| halmos | `0.3.3` (`uv tool install halmos --python /opt/homebrew/bin/python3.12`; PyPI latest), solver по умолчанию yices 2.6.4 |
| iron-памятка | `out -> forge-out` — halmos 0.3.3 читает только `out/`; симлинк обязателен для воспроизведения |

Новые файлы (все — тестовые, ни один продакшн-файл не правится):

- `jurisdictions/test/foundry/DepositoryConservation.invariants.t.sol` (+ `handlers/ConservationHandler.sol`) — цели 1 и 3;
- `jurisdictions/test/foundry/TransformerAllowance.invariants.t.sol` (+ `handlers/TransformerAllowanceHandler.sol`) — цель 2;
- `jurisdictions/test/foundry/HankoThreshold.invariants.t.sol` (+ `handlers/HankoThresholdHandler.sol`) — цель 4;
- `jurisdictions/test/foundry/HashLadder.invariants.t.sol` (+ `handlers/HashLadderHandler.sol`) — цель 5;
- `jurisdictions/test/foundry/HalmosLemmas.t.sol` (+ `helpers/SettlementDeltasHarness.sol`) — символьные леммы.

Паттерн — расширение `Depository.invariants.t.sol` + `DepositoryHandler.sol`:
stateful-хэндлер гоняет реальный `processBatch` через живой Hanko-путь
(`EntityProvider.verifyCurrentHankoSignature`), оракулы-счётчики фиксируют
свойства, которые пост-состояние само по себе не показывает;каждый инвариант имеет
мета-тест/контрол чувствительности (может ли он вообще покраснеть).

## Точные команды запуска

```bash
cd jurisdictions

# полный foundry-набор (инварианты: runs=128, depth=64; fuzz: runs=256)
forge test --match-path 'test/foundry/*'

# только новые наборы (порядок как в отчёте)
forge test --match-path 'test/foundry/DepositoryConservation.invariants.t.sol'
forge test --match-path 'test/foundry/TransformerAllowance.invariants.t.sol'
forge test --match-path 'test/foundry/HankoThreshold.invariants.t.sol'
forge test --match-path 'test/foundry/HashLadder.invariants.t.sol'
forge test --match-path 'test/foundry/HalmosLemmas.t.sol'

# halmos — ТОЛЬКО на малые леммы (check_*), не на весь набор
export PATH="$HOME/.local/bin:$PATH"
halmos --match-test 'allowanceGate'       --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'clampExact'          --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'orderedPairIsolation' --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'rootRoundTrip'       --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'nibbleReconstruct'   --loop 20 --solver-timeout-assertion 120s
```

`--match-test` в halmos 0.3.3 — суффикс к `^(check|invariant)_.*`, поэтому
паттерны без префикса `check_`. Голый `halmos` без `--match-test` запускать
нельзя: он пытается символьно исполнить stateful `invariant_*` без фаззер-стейта
и виснет (проверено, процесс убит).

## Цель 1: conservation (Σ reserves + Σ collateral + Σ debts)

Модель: 4 lazy-сущности, токены 1 (ERC20 A), 2 (ERC20 B), 3 (mint-only),
мульти-ногие батчи `mixedBatch`: 0–2 R2R, 0–2 R2C, ≤1 C2R, ≤1 settlement,
0–2 депозита, 0–2 вывода, 0–2 flashloan с дублирующимися tokenId; amounts
ограничены текущими балансами (+1 для достижения отказа); всего ≤ 8 операций
(лимит контракта 50). Административный mint — единственный нетранзакционный
источник ценности и полностью гхост-отслежен.

Формулировки (инвариант = свойство после КАЖДОЙ последовательности вызовов):

1. `invariant_valuePoolIsConserved` — точное равенство для каждого токена
   t ∈ {1,2,3}: `Σ_e reserves[e][t] + Σ_{e<e'} collateral[acct(e,e')][t] ==
   ghostMinted[t] + externalBacking(t)`, где `externalBacking` — баланс
   ERC20 на самом Depository (0 для t=3).
2. `invariant_everyBatchConservesValue` — оракул на каждый принятый
   `processBatch`: `Δ(Σreserves+Σcollateral)` по токену равно в точности
   изменению ERC20-баланса Depository по этому токену (для t=3 — равно 0);
   отвергнутый батч не меняет ничего (внутри одного external call).
3. `invariant_debtNeverEntersValuePool` — долги исключены из пула ценности
   (деbt — claim, не asset): lifecycle долгов не протекает в резервы.
   Изменение `Σ debts` легитимно (shortfall при finalize прощает/создаёт долг),
   поэтому цель «Σ debts unchanged» сознательно НЕ заявляется как инвариант —
   задокументировано отдельно от пула ценности.

Результат: PASS, 128 runs × depth 64 (8192 вызова на инвариант). Чувствительность
доказана `test_meta_conservationIsSensitive` (инъекция unbacked mint → ред).
Каждый возвращающий ценность путь перечислен по коду: mint, external deposit
(+), external withdraw (−), R2R/R2C/C2R/settlement/dispute/finalize/flashloan/
enforceDebts/forgive (0, перенос внутри пула), flashloan burn (0, симметричен
mint). Покрытие: ~2700 вызовов mixedBatch за набор с высоким уровнем приёмов (сводка call summary).

## Цель 3: nonce-монотонность (Depository.sol:339) и replay

Формулировки:

1. `invariant_entityNonceMatchesAcceptedCount` — `entityNonces[e]` в точности
   равен числу принятых батчей e (гхост обновляется только на accept).
2. `invariant_entityNonceStepsByExactlyOne` — принятый батч двигает nonce
   ровно на +1 (не +2, не назад); отвергнутый не двигает вовсе.
3. `invariant_replayedBatchIsRejected` — точный реплей последнего принятого
   `(encodedBatch, hanko, nonce)` тройника всегда отвергается, при любом
   порядке вызовов (`replayLast` — отдельное действие фаззера).

Результат: PASS. Чувствительность — `test_meta_nonceIsSensitive` (портим гхост
через брутфорс слота → ред). Ограничение модели: replay проверяется для
последнего принятого батча каждой сущности на глубине последовательности, а не
для произвольного исторического батча (исторический реплей — тот же nonce-check
путь в коде, но покрыт слабее; отмечено как расширение на deep-профиле).

## Цель 2: transformer allowances (Account.sol:996)

Модель: реальный dispute start + finalize через `processBatch`; ProofBody несёт
один TransformerClause на замороженный `TransformerLivenessHarness` (canonical
applyBatch ABI, режимы Add/Absolute); pull-путь не задействован (harness ≠
canonical DeltaTransformer, поэтому `_proofBodyContainsPull` = false и
counterparty может принять initial state сразу). offdelta ∈ [−1e21, 1e21],
allowances ∈ [0, 2e21]. Наблюдаемый дельта-результат реконструируется из
движения storage: `Δ_applied = Δreserve(L) − Δdebt(L) + Δdebt(R)` — формула
точна для всех трёх веток `Depository._applyAccountDelta` при нулевых долгах
до finalize (хэндлер это гарантирует).

Формулировки:

1. `invariant_noDeltaChangeWithoutAllowance` (Account.sol:996-1000) — ни один
   принятый finalize не применил изменение delta j без allowance на j.
2. `invariant_allowancedChangesAreExactlyClamped`
   (Account.sol:_clampTransformerValue) — применённая дельта равна в точности
   `clamp(requested, prev − rightAllowance, prev + leftAllowance)` (band в
   signed-домене; упорядоченная uint-арифметика контракта совпадает с signed
   в этих границах).
3. `invariant_finalizeConservesValue` — finalize не меняет
   `Σreserves+Σcollateral` ни по одному токену (collateral → резервы).
4. `invariant_valuePoolIsConserved` — общий conservation (как в цели 1).

Результат: PASS (7/7, включая два детерминированных контрола):
`test_control_unallowancedChangeRevertsFinalization` — Absolute(5000) без
allowance обязательно реверсит весь батч (gate реально стреляет);
`test_control_clampAppliesExactBand` — prev=1100, band [1050,1150],
requested 5000 применяется ровно как 1150 (1000 collateral + 150 shortfall
из резерва RIGHT) — неказуальность покрыта числом.

Символьная лемма (та же цель, но без сигнатур — см. Halmos ниже):
`check_allowanceGate` и `check_clampExact` на РЕАЛЬНОМ
`Account.prepareSettlementDeltas` через `SettlementDeltasHarness`.

## Цель 4: Hanko-порог и HANKO_FIRST_MEMBER_EOA_REQUIRED

Модель: пробы через `EntityProvider.verifyCurrentHankoSignature` — тот самый
вызов, который делает `processBatch` (Depository.sol:334). Гхост — НЕ
реимплементация верификатора, а sound lower bound реального ECDSA-бэкинга:
`backing(claim) = Σ весов сигнатурных участников + Σ весов nested-участников,
чей собственный backing ≥ их threshold`. Контракт считает вес nested-участника
безусловно, но требует, чтобы каждый nested-claim сам прошёл порог — поэтому
на любом ПРИНЯТОМ proof `backing == contract votingPower`, и «accepted при
backing < threshold» — это в точности обход порога.

Формулировки:

1. `invariant_quorumNeverBelowThreshold` — ни один принятый proof не содержал
   claim с ECDSA-бэкингом ниже объявленного threshold.
2. `invariant_firstMemberIsAlwaysEoaSignature` (HankoVerifier.sol:207-214,
   on-chain зеркало TS `HANKO_FIRST_MEMBER_EOA_REQUIRED`) — в каждом claim
   принятого proof первый participant есть сигнатура/плейсхолдер с EOA-формой
   (≠0, ≤ uint160 max), никогда — nested claim (nested не может
   самозаписаться в первый слот).
3. `invariant_unsatisfiableProofsAreRejected` — конструкции с известным
   «должно быть отказано» (threshold выше достижимой мощности; ненасыщенный
   nested-base; nested-first-member) никогда не принимаются.
4. `invariant_validProofsAreAccepted` — зеркальная живость: валидные
   конструкции не отвергаются (лочит lazy-сущности из processBatch).

Источники случайности: `probe(seed)` — adversarial-форма (плейсхолдеры
EOA/не-EOA, ленивые и мусорные entityId, nested-ссылки, thresholds 1–4,
веса 1–3, 1–3 подписи, 1–3 claims); `probeCanonical(seed)` — 4 варианта с
известным ожиданием (accept / порог+1 / ненасыщенный nested / nested-first).

Результат: PASS. Контроли: `test_control_twoOfTwoLazyBoardAccepted`
(2-of-2 lazy board принимается, возвращается точный entityId) и
`test_control_oneSignatureBelowThresholdRejected` (одна подпись +
плейсхолдер отсутствующего подписанта = 0 voting power → отказ и (0,false)).
Покрытие за финальный шринк: accepted=4, все с nested; по всем 128 runs
принятых проб существенно больше (probeCanonical вызван 4150 раз).

## Цель 5: hash-ladder ordered-pair слоты

Контракт: `HashLadderRegistry.registerReveal` на storage Depository
(единственный писатель — `processBatch.hashLadderRegistrations`, внешний Hanko
аутентифицирует revealer). Слот: `(revealerEntity, counterpartyEntity,
ladderHash, role)` — пара НЕ сортируется. Модель: 4 актора, 6 пар, окна
50s/50s; partial-свидетели выводятся из bucket-баз (bucket 0–3), так что
ОДИН И ТОТ ЖЕ слот повторяется между вызовами — retry-семантика реально
проверяется (partialRoot не зависит от ratio по построению лестницы:
root = H^15(base) для любого digit).

Формулировки:

1. `invariant_orderedPairSlotsAreIsolated` — каждый гхост-слот совпадает с
   цепочкой `getHashLadderReveal(...)` в точности (ratio и revealedAt), а
   ОБРАТНЫЙ слот `(counterparty, revealer, ladder, role)` читается нулём,
   если обратный участник сам его не писал: запись A→B не протекает в (B,A).
2. `invariant_sourceRevealsAreSticky` — Source single-shot: конфликтующий
   retry (другой ratio на тот же слот) никогда не принимается; точный retry —
   sticky no-op (гхост не двигается, включая revealedAt).
3. `invariant_targetRevealsNeverDecrease` — Target монотонен: меньший replay
   отвергается; равный/больший освежает timestamp (проверяется гхост-равенством).
4. `invariant_sourceFirstWriteNeedsWindow` — первый Source-write принимается
   только внутри `[S, S + ownerResponseSeconds]` при живом диспуте
   (в модели окон 50s/50s).

Результат: PASS. Контроли: `test_control_orderedPairIsolation` (конкретная
запись A→B: прямой слот = ratio, обратный = 0; затем B→A пишет свой слот);
`test_control_sourceSingleShotSemantics` (без диспюта — отказ; в окне —
запись; точный retry через 10с — revealedAt не двинулся; конфликтующий —
отказ). Покрытие: ~2700 registerReveal-вызовов, принятые Source+Target записи
и отклонения обоих классов (registrations ok/rejected ненулевые).

## Halmos: малые леммы

Мотивация и ограничение: nonce-лемма `processBatch` требует валидного ECDSA
Hanko (`vm.sign` бетонен), поэтому символьно недостижима — она закрыта
stateful-фаззом цели 3. Вместо этого символьно проверен код, который владеет
gate/clamp: `Account.prepareSettlementDeltas` НЕ проверяет подписи (их
проверяют вызывающие), поэтому `SettlementDeltasHarness` со своей storage
исполняет точный продакшн-код библиотеки с символьными входами.
Bounded-модель: |ondelta|, |offdelta|, |value| ≤ 2^40, allowances ≤ 2^40,
1 токен, 1 clause, пустые argument-wrappers, loop-bound 20 (лестница ≤ 15
итераций).

| Лемма | Свойство | paths | время | статус |
|---|---|---|---|---|
| `check_allowanceGate` | без allowance: non-artifact revert ⇔ запрошено изменение delta 0; иначе delta0 == prev | 95 | 0.80s | PASS |
| `check_clampExact` | с allowance: не реверсит; delta0 == clamp(requested, prev±allowances) точно; sign == bitmap&1 | 953* | 10.44s | PASS |
| `check_orderedPairIsolation` | full-fill Target-регистрация пишет только прямой ordered-слот; обратный читает (0,0) | 4 | 0.71s | PASS |
| `check_rootRoundTrip` | `rootFromReveal(revealForNibble(base,d),d) == rootFromBase(base)` ∀d∈[0,15] | 17 | 0.48s | PASS |
| `check_nibbleReconstruct` | 4 nibbleAt восстанавливают uint16 ratio | 2 | 0.00s | PASS |

\* Числа путей halmos нестабильны между пересборками (аудит c4-repro получил
982 против 953 для clampExact, 96 против 95 для allowanceGate, ±3%) — считать
порядком величины, не точным значением.

Solver timeouts: НЕ достигнуты (лимит `--solver-timeout-assertion 120s` не
сработал ни разу; самый тяжёлый query — `check_clampExact`, 10.44s суммарно).

### Известный артефакт halmos 0.3.3 (задокументирован, не обходён молча)

`gasleft()` моделируется символьно, поэтому ветка
`TransformerGasBudgetUnavailable` (Account.sol:887/1102) достижима в модели
при ЛЮБЫХ входах — включая полностью бетонный нулевой (подтверждено
минимальным репро: `check_gateZeroConcrete` FAIL на halmos, тот же вызов
PASS на реальном EVM). Workaround: harness классифицирует revert-данные и
возвращает `gasArtifact = (selector == TransformerGasBudgetUnavailable)`;
леммы толерируют ровно этот селектор и ничего больше. На реальном EVM ветка
недостижима (foundry gas_limit 300M; 256 fuzz-прогонов лемм — ноль revert'ов).

## Итоговые прогоны

- `forge test --match-path 'test/foundry/*'` → **75 passed / 2 failed**;
  оба фейла — ДОСУЩЕСТВОВАВШИЕ до задачи, во фрозен-файлах (см. «Найденное»);
  все 35 новых тестов зелёные. Время ~45s (59.65s CPU).
- Новые наборы по отдельности — все PASS (9+7+7+7+5 тестов).
- halmos — 5/5 PASS (таблица выше).

## Найденное (reported, NOT fixed — контракты фрозен)

1. **[pre-existing, frozen test] `BatchBounds.t.sol::test_gas_maxReserveToCollateralProduct`** —
   gas 15_049_243 ≥ бюджет 15_000_000 (R2C product 256 пар). Воспроизводится
   на бейзлайне ДО моих правок (тот же фейл на pinned SHA 80924b0).
2. **[pre-existing, frozen test; ПЕРЕКЛАССИФИЦИРОВАНО аудитом c4-repro, подтверждено
   первичной проверкой] `DebtChunking.t.sol::test_forgivenessAfterPartialEnforcementKeepsBooksExact`** —
   «forgiveness left residual debt: 200 != 0». НЕ расхождение bookkeeping:
   `_assertBooksAgree` проходит; `_forgiveDebtsBetweenEntities`
   (Depository.sol:833-858) по дизайну прощает ровно ОДИН cursor-head долг за
   settlement (FIFO O(1), комментарий 842-844 запрещает скан хвоста); остаток 200 =
   два полных FIFO-вхождения (2×100), а тест ожидает, что один settlement очистит
   все три. Это конфликт «ожидание теста vs дизайн O(1)-прощения», деньги не
   теряются. Решение владельца: править ожидание теста (серии settlement'ов) или
   менять дизайн на дренирование очереди (газ-риск). Первоначальная формулировка
   «кандидат в расхождение bookkeeping» выше была неточной — см.
   proofs/audits/c4-repro/report.md.
3. **[halmos 0.3.3 artifact] символьный `gasleft()`** — см. раздел выше;
   свойства контракта не нарушены (бетонный прогон зелёный).
4. **[coverage gap, задокументирован] replay исторических батчей** (не только
   последнего принятого) и `FOUNDRY_PROFILE=deep` (1024×128) прогон новых
   наборов — логичное расширение, не блокер.

Контрактных багов по целям 1–5 не найдено: все инварианты зелёные на текущем
байткоде, контроли чувствительности краснеют по требованию.
