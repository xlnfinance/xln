# C1: дифференциальный фаззинг канонических энкодеров TS ↔ Rust

Claim (матрица `proofs/readme.md`, C1): канонические энкодеры TypeScript и Rust
побайтово эквивалентны на случайных и острых входах — в пределах модели,
описанной ниже. Сформулировано без слова «невозможно»: утверждение охватывает
только перечисленные домены и границы.

## Эвидентность (окружение на момент запуска)

| Параметр | Значение |
|---|---|
| `git rev-parse HEAD` | `80924b035f363d4ad8f4a8c08e6f39dcc7736a78` |
| `git status --porcelain \| wc -l` | `243` (все — незакоммиченные изменения параллельных задач; ни один файл этой задачи не правит продакшн: всё новое лежит в `proofs/fuzz/enc-diff/`) |
| bun | `1.3.14` (движок JS — JavaScriptCore) |
| cargo / rustc | `1.94.1 (29ea6fb6a 2026-03-24)` / `1.94.1 (e408947bf 2026-03-25)` |
| ryu-js (lock) | `1.0.3` |
| serde_json (lock) | `1.0.151` |
| num-bigint (lock) | `0.4.8` |
| sha2 (lock) | `0.10.9` |

Компоненты (все файлы новые, `proofs/fuzz/enc-diff/`):

- `generate.ts` — единственный источник корпуса: детерминированный PRNG
  (splitmix64-подобный), тегированная JSON-схера `CanonicalValue`
  (`null|bool|num(js-canonical text)|bign(decimal)|str|arr|map|set|obj`,
  плюс `undef` для own-property со значением `undefined`), острые seed'ы и
  случайные случаи всех 7 видов.
- `enc-diff-rust/` — standalone-крейт (не член workspace `rscore`), path-deps
  `../../../../rscore/crates/{protocol,engine}`; читает корпус, печатает
  JSONL `{file, hex|error}`. Все отказы обязаны приходить из продакшн-кода
  rscore, кроме моделирования границы `undefined` (см. ниже).
- `run.ts` — реконструирует вход из тегированной схемы, кодирует TS-стороной,
  гоняет rust-бинарь один раз на корпус, сравнивает по классу случая,
  авто-минимизирует расхождения (сброс элементов/полей, ужесточение скаляров).
- `corpus/` — закоммиченный seed-корпус (200 файлов: 114 острых seed'ов +
  86 случайных, seed `20260826`). Полный корпус регенерируется скриптом.

## Точные команды запуска

```bash
bun proofs/fuzz/enc-diff/generate.ts --count 10000 --seed 20260826 --out proofs/fuzz/enc-diff/corpus-full
cd proofs/fuzz/enc-diff/enc-diff-rust && cargo build --release && cd -
bun proofs/fuzz/enc-diff/run.ts --corpus proofs/fuzz/enc-diff/corpus-full
# дополнительный ryu_js-прогон (только случайные binary64):
bun proofs/fuzz/enc-diff/generate.ts --numbers-only --count 50000 --seed 424242 --out /tmp/corpus-numbers
bun proofs/fuzz/enc-diff/run.ts --corpus /tmp/corpus-numbers
# повтор на других seed'ах:
bun proofs/fuzz/enc-diff/generate.ts --count 10000 --seed 777    --out /tmp/corpus-777
bun proofs/fuzz/enc-diff/run.ts --corpus /tmp/corpus-777
bun proofs/fuzz/enc-diff/generate.ts --count 10000 --seed 31337  --out /tmp/corpus-31337
bun proofs/fuzz/enc-diff/run.ts --corpus /tmp/corpus-31337
```

## Прогон и результат

Основной прогон `--count 10000 --seed 20260826` → 10 114 случаев (114 seed'ов +
10 000 случайных), плюс два повтора (777, 31337 — по 10 114), ryu_js-прогон
50 114 и закоммиченный seed-корпус 200. Итого **80 656 случаев, 0 расхождений**.
Основной прогон по классам:

| class | случаев | ok | провалов | смысл |
|---|---|---|---|---|
| both-encode | 9 353 | 9 353 | 0 | обе стороны кодируют, байты равны (для radix-tree также равны depth/leafCount/branchCount/extensionCount/maxDepth) |
| both-reject | 751 | 751 | 0 | обе стороны отказывают |
| rust-rejects | 7 | 7 | 0 | TS кодирует, Rust отказывает (задокументированная асимметрия, см. ниже) |
| ts-only | 3 | 3 | 0 | TS кодирует, Rust не моделирует вид tx |

По видам (основной прогон): value 4 444; tx 2 634; flat-root 1 006;
radix-tree 552; radix-leaf 494; radix-branch 500; radix-extension 484.
ryu_js-прогон: 50 093 случайных конечных binary64 — `String(n)` (JSC) ≡
`ryu_js::Buffer::format` (Rust) на каждом; кодировки побайтово равны.

Попарно покрытые функции:

1. `encodeAccountStateValue` (`core/account/commitment/account-state-value.ts`)
   ↔ `encode_account_state_value` (`rscore/crates/protocol/src/value.rs`),
   включая порядок: map/set — по закодированным байтам ключей/элементов;
   object — по UTF-16 (`compareStableText` ↔ `cmp_utf16`); seed'ы с ключами,
   переворачивающими порядок UTF-16 vs UTF-8 (`U+FFFB/U+FFFE/U+FFFF` vs
   `U+10000/U+1F600`), прошли побайтово.
2. `computeFlatIntegrityRoot` (`core/account/commitment/state-root.ts`, через
   экспорт `computeCanonicalMerkleRoot(ns, entries, 'integrity')`) ↔
   `compute_flat_integrity_root` (`rscore/crates/protocol/src/flat.rs`).
3. Radix: `computeRadixMerkleLeafHash` ↔ `hash_leaf`;
   `computeRadixMerkleBranchHashFromSlots(16, …)` ↔ `hash_branch16`;
   `hash_extension16` ↔ TS-путь `computeRadixMerkleEdgeHash(16, [], 'branch',
   [dummy, …path], h)` (публичный TS API не экспортирует хэш расширения
   напрямую; сегмент родителя отбрасывает ровно фиктивный слот);
   `buildRadixMerkle(radix 16, 'integrity')` ↔ `build_radix16_merkle`
   (корень + все счётчики). Алгоритм 'integrity' = sha256.
4. `canonicalAccountTxForFrameHash` (`core/account/consensus/frame/hash.ts`,
   сравнение кодировок канонической формы `{type,data}`) ↔ `canonical_tx_value`
   (`rscore/crates/engine/src/consensus/frame/hash.rs`) по всем 10 нативным
   видам: direct_payment, add_delta, set_credit_limit, rebalance_policy,
   swap_offer, swap_resolve, swap_cancel_request, htlc_lock (с/без envelope и
   deliveryMode), htlc_resolve (secret / error±reason), j_event_claim
   (events + leftProof/rightProof, включая keccak256 eventsHash и
   канонизацию событий AccountSettled обеими сторонами).

Дополнительно на каждом случае (внутренние инварианты, бесплатно):
TS fast-writer ≡ `encodeAccountStateValueOracle` (все value-случаи);
Rust streaming `write_account_state_value` ≡ аллоцирующий
`encode_account_state_value` (все value-случаи).

## Проверенные свойства кодека (формулировки readme)

В рамках C1 проверена дифференциальная часть формул задач 1/6/7:

- **Эквивалентность encode**: для каждого `x` из домена генератора
  `encodeTS(reconstruct(x)) = encodeRust(reconstruct(x))` побайтово —
  т.е. канонические байты инвариантны к движку. Это необходимая база
  `encode(decode(canonicalBytes)) = canonicalBytes` (re-encode) и
  `decode(encode(x)) = normalize(x)`; сами decode-свойства — задача C7
  (cargo-fuzz парсеры), здесь не claimed.
- **Паритет отказов** (обе стороны обязаны отказаться): дубли ключей map,
  значений set, ключей object; NaN/Infinity/-Infinity (TS:
  `ACCOUNT_STATE_RLP_NON_FINITE_NUMBER`, Rust: `CANONICAL_NUMBER_NON_FINITE`);
  radix: дубли ключей листьев и смешанные длины ключей; слот ≥ 16 в extension.
  Тексты ошибок у сторон разные by design — сравнивалась факт-наличность
  отказа, образцы текстов в обеих сторонах зафиксированы в run.ts stdout.
- **Любой принятый wire-input каноничен**: число проходит только в
  каноническом JS-рендеринге (`ryu_js` round-trip в Rust) — все
  неканонические тексты (`01`, `+1`, `1.0`, `1e21`, `1e+20`,
  `123456789012345678`, `-0`, `0.0000001`) Rust отвергает; JS-сторона такие
  тексты не порождает никогда (`String(n)`).

## Острые края (обязательные seed'ы readme) — все в корпусе

- Суррогатные пары/не-BMP: пары валидны всегда; изоляции (lone surrogates)
  вне модели — JS `TextEncoder` хэширует их как U+FFFD, Rust-строка не может
  их содержать; генератор исключает (в т.ч. обрезку пары при slice).
- `ryu_js` round-trip и границы JS_MAX_SAFE_INTEGER (`9007199254740991`,
  `-9007199254740991`, `123456789012345680` — округление binary64),
  `-0` (JS кодирует `String(-0)="0"`; текст "-0" Rust отвергает —
  закоммичено как класс `rust-rejects`), `1e+21` (канонический экспоненциальный
  порог), `1e21`/`1e+20` (неканоничные тексты — Rust отвергает),
  `5e-324`, `±1.7976931348623157e+308`, `1e-7`/`0.000001` (порог экспоненты).
- Нулевой BigInt: `0` → magnitude-байт `[0]`, не пусто (seed `bigint-0`);
  границы байта `255/256`, `65535/65536`, 2^128.
- Пустые Array/Set/Map/object и вложенные пустоты.
- Дубли ключей (map/set/object): обе стороны отказывают (класс both-reject).
- Строки ровно 55/56 байт UTF-8 в кодировках 1/2/3/4 байта на символ
  (RLP-граница короткой формы), плюс 0 и 1024 байта.
- Own-property со значением `undefined`: TS-энкодер пропускает до RLP;
  wire-схема несёт тег `undef`, TS-драйвер строит реальный `{a: undefined}`,
  Rust-драйвер дропает entry на границе (Rust-тип не имеет undefined) —
  байты равны объекту без этого поля.

## Найденные/задокументированные асимметрии (не чинились — продакшн не трогаем)

Ни одна не является расхождением байтов на общем домене; каждая —
сознательная граница валидации, зафиксированная корпусом как отдельный класс:

1. **Неканоничные тексты чисел** (`-0`, `1e21`, `1.0`, `01`, `+1`,
   `123456789012345678`): Rust `parse_js_canonical` отвергает; TS
   `encodeAccountStateValue` принимает ЛЮБОЙ JS `number` и кодирует его
   `String(n)`. На уровне значений расхождения нет (JS не отдаёт
   неканоничный текст), на уровне сырого текста Rust строже.
2. **`rebalance_policy.policyVersion > 2^53-1`** (seed
   `tx-policy-unsafe-version`, `9007199254740992`): TS хэширует рендеринг
   double `"9007199254740992"`, Rust отказывает (`UnsafeInteger`). Если
   TS-mempool когда-либо пропустит такой tx в frame, Rust-узел не сможет
   воспроизвести frame-hash. Сегодня Rust `is_frame_hashable`/admission
   отсекает такие tx на своей стороне; рекомендовано владельцу решить,
   должна ли TS-сторона зеркально отказывать на admission.
3. **TS-only виды tx** (`lending_fund`, `reserve_to_collateral` — реальные
   Rust-варианты, но `canonical_tx_value` возвращает `UnsupportedFrameTx`;
   `request_collateral` и прочие — в Rust вообще нет варианта): TS
   `canonicalAccountTxForFrameHash` хэширует passthrough. Rust сознательно
   оставляет эти переходы TS-движку; frame с таким tx Rust не хэширует.
4. **`hash_leaf` value-домен**: Rust типизирован `[u8;32]` (digest), TS
   `computeRadixMerkleLeafHash` принимает произвольную длину value.
   Паритет проверен на 32-байтовых digest'ах (продакшн-путь integrity).
   Аналогично `hash_extension16([])` (пустой путь) в Rust хэширует, а TS
   публичный API пустой сегмент возвращает как child-hash — пустой путь
   недостижим в дереве ни с одной стороны; вне модели.
5. **Дубли слотов branch16**: Rust `hash_branch16` отвергает дубликаты слотов;
   TS публичный API — плотный массив из 16 слотов, дубликаты невыразимы.
   Проверка на отталкивание невыполнима через TS API (защита Rust в глубину).

## Калибровка минимизатора (правило 4 readme)

Известный список багов B1–B8 не передан; калибровка выполнена синтетической
дивергенцией: обёртка над rust-бинарем портила hex одного случая
(`seed-map-mixed-keys`) — harness зафиксировал `BYTES_DIFFER` и
авто-минимизировал до `{t:'map',v:[]}` за одну сессию (артефакт
`/tmp/minimized-test`). Без оракула-саботажа 0 живых расхождений →
`minimized/` пуст; закоммиченных падших кейсов нет.

## Bounded-допущения (пределы модели)

- value-деревья: глубина ≤4 (seed глубина 12), ширина ≤4 (seed 200);
  строки ≤~24 симв. случайные (seed'ы байт-точные 0/54/55/56/1024);
  bigint ≤40 hex-цифр (до ~160 бит); строки — только well-formed Unicode.
- flat-root: ≤6 entries, namespace/path — короткие (seed'ы: пустой, дубликат
  пути, не-BMP, 55/56 байт).
- radix16 + 'integrity' только (Rust моделирует только radix16);
  ключи деревьев ≤6 байт, ≤8 листьев (seed'ы: 16 листьев full-fan, empty,
  общий префикс); digest'ы 32 байта.
- tx: 10 нативных видов, поля в валидных для Rust доменах (tokenId u16/u32,
  u64-safe высоты/версии), optionals ~50/50; j_event_claim ≤3 событий,
  proofs ≤3 узлов; envelope 48..160 байт canonical-base64; hashlock/идентификаторы
  0x+64 lowercase hex; резервы — канонические десятичные строки.
- Не покрыто (осознанно): decode-свойства (C7), keccak-ветка
  `computeCanonicalMerkleRoot(…, 'keccak256')`/`buildHexKeyedMerkle` (Rust
  не имеет keccak-радикса), frame-hash целиком (собран из flat-root +
  canonical tx, покрыт по частям и векторами в самих репо-тестах).

## Воспроизведение артефактов

- Закоммиченный корпус: `corpus/` (200 файлов, seed `20260826`, count 86
  случайных + 114 seed'ов) — `bun proofs/fuzz/enc-diff/run.ts` зелёный на нём
  без аргументов `--corpus`.
- Полный корпус любого объёма: `generate.ts --count N --seed S --out …`
  (детерминирован: тот же seed → тот же корпус).
- Rust-бинарь: `cargo build --release` в `enc-diff-rust/` (Cargo.lock
  закоммичен).
