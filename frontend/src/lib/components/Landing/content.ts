/**
 * Landing Page Content - EN/RU translations
 * Separate file to avoid bloating the component
 */

export const content = {
  en: {
    hero: {
      title: "One protocol. Every jurisdiction. Every programmable ledger.",
      subtitle: "The universal CBDC substrate for planetary-scale settlement"
    },
    founder: {
      quote: "After 13 years auditing payment systems and blockchains, I built the protocol I kept wishing existed.",
      signature: "Egor Homakov"
    },
    problem: {
      title: "137 Countries Are Building Programmable Money",
      intro: "CBDCs, stablecoins, tokenized assets—98% of global GDP is going programmable. The $100 trillion question isn't <em>if</em> programmable ledgers win. It's <strong>how they scale without custodians</strong>.",
      vision: "Every existing answer fails at planetary scale:",
      tradfi: "<strong>TradFi/CEX (traditional banks, Binance, Coinbase):</strong> $100T economy, $10T daily volume, but custodial — bank bailouts, FTX collapse, Mt. Gox",
      bigBlocks: "<strong>All big blockers (Solana, Tron, BSC):</strong> $80B+ market cap, but can't run full nodes — centralized by design",
      rollups: "<strong>All rollups (Arbitrum, Optimism, zkSync, StarkNet):</strong> $10B+ TVL, but data availability paradox — trust third-party committees, ephemeral calldata, or expensive blobspace. The DA/verifier dilemma is mathematically unsolvable: you cannot have cheap verification, permanent data, and no trust assumptions simultaneously. It's a catch-22, not a tradeoff.",
      sharding: "<strong>Sharding chains (NEAR, TON, Zilliqa, MultiversX):</strong> Still broadcast O(n) within shards — doesn't solve the fundamental bottleneck. Security dilution means one shard compromised, entire network at risk. Fishermen are security theater that breaks under economic pressure.",
      fcuan: "For centuries, finance ran on <strong>Full-Credit Unprovable Account Networks (FCUAN)</strong>: traditional banking, CEXs, brokers. Pure credit scales phenomenally but offers weak security—assets can be seized, hubs can default.",
      frpap: "In 2015, Lightning introduced <strong>Full-Reserve Provable Account Primitives (FRPAP)</strong>: payment channels with cryptographic proofs. Full security but hits the <em>inbound liquidity wall</em>—an architectural limit, not a bug. Lightning, Raiden, Connext, Celer — all payment channel projects are now dead or pivoted due to full-reserve constraints."
    },
    solution: {
      title: "The Solution",
      intro: "<strong>xln</strong> is the first <strong>Reserve-Credit Provable Account Network (RCPAN)</strong>: credit where it scales, collateral where it secures. A principled hybrid.",
      evolution: "The Evolution of Settlement",
      fcuanDesc: "Banking. Pure credit, 7000 years dominant.",
      frpapDesc: "Lightning. Failed (liquidity wall).",
      rcpanDesc: "<strong>xln:</strong> Banking + Lightning = RCPAN. The logical end."
    },
    whyNow: {
      title: "Why Now?",
      items: [
        "<strong>2025:</strong> 72 CBDCs in pilot phase",
        "<strong>2026:</strong> Cross-border CBDC interop becomes political imperative",
        "<strong>Legacy rails incompatible:</strong> SWIFT and correspondent banking can't handle programmable money",
        "<strong>Window closing:</strong> Each CBDC building incompatible scaling solution creates permanent fragmentation",
        "<strong>Universal substrate needed NOW:</strong> Before standards ossify"
      ]
    },
    contracts: {
      title: "Modular Contract System",
      subtitle: "The entire financial system as pluggable Lego bricks. Deploy your own. Extend forever.",
      note: "<strong>Depository</strong> = immutable trust anchor. <strong>Modules</strong> = hot-swappable implementations. Deploy <code>YourCustomEntityProvider.sol</code> anytime."
    },
    properties: {
      title: "Key Properties",
      items: [
        "Infinite scalability: O(1) per-hop updates vs O(n) broadcast",
        "No inbound liquidity problem: credit + collateral hybrid",
        "Bounded risk: counterparty loss capped at collateral + credit",
        "Strong privacy: onion-routing (payment sender/receiver anonymous to routing hubs, like Tor for money)",
        "<strong>Local state: no sequencers, no data availability dependencies</strong>"
      ]
    },
    tripleS: {
      title: "Triple-S First Principles",
      scalable: {
        title: "Scalable",
        desc: "<strong>Unicast (1-to-1)</strong> architecture enables unbounded horizontal scaling. No broadcast bottlenecks, no global consensus delays.",
        detail1: "O(1) per-hop updates vs O(n) broadcast overhead. Counterparties self-select optimal routing paths through Coasian negotiation — from CBDCs to coffee, village to globe.",
        detail2: "There is simply no other way to scale to the entire planet. The internet already proved unicast wins at global scale."
      },
      secure: {
        title: "Secure",
        desc: "<strong>Every phone and laptop will be a full node by default.</strong> Non-negotiable.",
        detail1: "L1 blockchains handle only final netting — not every coffee purchase. This ultra-low settlement load means even phones can verify the entire chain. State pruning keeps storage minimal: full verification, not full history. No light clients, no trust assumptions.",
        detail2: "This implements the original vision of Satoshi and Vitalik: self-sovereign verification without trusted intermediaries. Your keys, your node, your rules."
      },
      simple: {
        title: "Simple",
        desc: "<strong>Banking 2.0</strong> with zero new terminology invented.",
        detail1: "Credit, collateral, reserves, transfers. Concepts you already know. No zkSNARKs to understand, no merkle trees to audit. Just finance, but programmable.",
        detail2: "Complexity hidden in the protocol. Simplicity exposed to users. That's how the internet scaled — and that's how finance will scale."
      }
    },
    roadmap: {
      title: "Roadmap",
      q4_2025: { quarter: "Q4 2025", title: "Protocol Design Complete", items: ["Runtime architecture finalized", "Bilateral consensus spec", "Smart contract design"] },
      q1_2026: { quarter: "Q1 2026", title: "Testnet Launch", items: ["Deploy on Ethereum Sepolia", "Developer sandbox with demo entities", "Public API documentation"] },
      q2_2026: { quarter: "Q2 2026", title: "Multi-Chain Expansion", items: ["Arbitrum, Optimism, Base support", "Cross-chain settlement demos", "Performance benchmarks published"] },
      q3_2026: { quarter: "Q3 2026", title: "Security Audits & Mainnet Beta", items: ["Third-party security audits", "Bug bounty program launch", "Mainnet beta with whitelisted entities"] },
      q4_2026: { quarter: "Q4 2026", title: "Public Mainnet", items: ["Open entity registration", "Production-grade SDKs (TypeScript, Python)", "Governance framework activation"] },
      future: { quarter: "2027+", title: "CBDC Integration Layer", items: ["Partnerships with central banks", "Programmable CBDC substrate", "Universal interop protocol"] }
    },
    newsletter: {
      title: "Join the Unicast Revolution",
      subtitle: "Get notified about mainnet launch, technical deep-dives, and protocol updates",
      placeholder: "your@email.com",
      button: "Subscribe",
      note: "No spam. Unsubscribe anytime."
    },
    cbdc: {
      title: "The Universal CBDC Substrate",
      intro: "xln isn't just \"better payment channels\" — it's the settlement layer for programmable money at planetary scale.",
      today: "<strong>Today:</strong> Universal EVM substrate — works with any EVM chain (Ethereum L1, rollups, alt-L1s: Polygon, Arbitrum, Base, BSC, etc.)",
      tomorrow: "<strong>Tomorrow:</strong> Same substrate serves CBDCs — when central banks launch EVM-compatible programmable money, xln becomes the universal interop layer",
      countries: "countries",
      pilot: "in pilot phase",
      gdp: "of global GDP",
      building: "building programmable ledgers",
      vision: "Most will be EVM-compatible. xln attaches to <strong>any</strong> programmable ledger by deploying <code>Depository.sol</code>."
    },
    invite: {
      placeholder: "Access Code",
      button: "Unlock",
      invalid: "Invalid code"
    }
  },
  ru: {
    hero: {
      title: "Один протокол. Любая юрисдикция. Любой программируемый реестр.",
      subtitle: "Универсальный субстрат для CBDC планетарного масштаба"
    },
    founder: {
      quote: "После 13 лет аудита платёжных систем и блокчейнов я создал протокол, о котором всегда мечтал.",
      signature: "Егор Хомаков"
    },
    problem: {
      title: "137 стран создают программируемые деньги",
      intro: "CBDC, стейблкоины, токенизированные активы — 98% мирового ВВП переходит на программируемые деньги. Вопрос на $100 триллионов не в том, <em>победят ли</em> программируемые реестры. А в том, <strong>как масштабироваться без кастодианов</strong>.",
      vision: "Все существующие решения не справляются в планетарном масштабе:",
      tradfi: "<strong>TradFi/CEX (традиционные банки, Binance, Coinbase):</strong> экономика $100T, $10T дневного оборота, но кастодиальная модель — банковские bailouts, крах FTX, Mt. Gox",
      bigBlocks: "<strong>Все big blockers (Solana, Tron, BSC):</strong> $80B+ капитализации, но нельзя запустить полную ноду — централизация by design",
      rollups: "<strong>Все роллапы (Arbitrum, Optimism, zkSync, StarkNet):</strong> $10B+ TVL, но парадокс доступности данных — доверяй комитетам, временным calldata или дорогому blobspace. Дилемма DA/verifier математически неразрешима: нельзя одновременно иметь дешёвую верификацию, постоянные данные и отсутствие trust assumptions. Это catch-22, а не компромисс.",
      sharding: "<strong>Шардинг (NEAR, TON, Zilliqa, MultiversX):</strong> Всё ещё broadcast O(n) внутри шардов — не решает фундаментальное узкое место. Размывание безопасности означает: один шард скомпрометирован — вся сеть под угрозой.",
      fcuan: "Веками финансы работали на <strong>Full-Credit Unprovable Account Networks (FCUAN)</strong>: традиционный банкинг, CEX, брокеры. Чистый кредит отлично масштабируется, но слабая безопасность — активы могут изъять, хабы могут обанкротиться.",
      frpap: "В 2015 Lightning представил <strong>Full-Reserve Provable Account Primitives (FRPAP)</strong>: платёжные каналы с криптографическими доказательствами. Полная безопасность, но упирается в <em>стену входящей ликвидности</em> — это архитектурное ограничение, не баг. Lightning, Raiden, Connext, Celer — все проекты платёжных каналов мертвы или переориентировались из-за full-reserve ограничений."
    },
    solution: {
      title: "Решение",
      intro: "<strong>xln</strong> — первая <strong>Reserve-Credit Provable Account Network (RCPAN)</strong>: кредит там, где нужно масштабирование, залог там, где нужна безопасность. Принципиальный гибрид.",
      evolution: "Эволюция расчётов",
      fcuanDesc: "Банкинг. Чистый кредит, 7000 лет доминирования.",
      frpapDesc: "Lightning. Провал (стена ликвидности).",
      rcpanDesc: "<strong>xln:</strong> Банкинг + Lightning = RCPAN. Логический финал."
    },
    whyNow: {
      title: "Почему сейчас?",
      items: [
        "<strong>2025:</strong> 72 CBDC в пилотной фазе",
        "<strong>2026:</strong> Трансграничная совместимость CBDC становится политическим императивом",
        "<strong>Legacy-рельсы несовместимы:</strong> SWIFT и корреспондентский банкинг не справятся с программируемыми деньгами",
        "<strong>Окно закрывается:</strong> Каждый CBDC с несовместимым решением создаёт необратимую фрагментацию",
        "<strong>Универсальный субстрат нужен СЕЙЧАС:</strong> Пока стандарты не окостенели"
      ]
    },
    contracts: {
      title: "Модульная контрактная система",
      subtitle: "Вся финансовая система как подключаемые Lego-кирпичики. Разверните свои. Расширяйте навсегда.",
      note: "<strong>Depository</strong> = неизменяемый якорь доверия. <strong>Модули</strong> = горячая замена реализаций. Разверните <code>YourCustomEntityProvider.sol</code> в любое время."
    },
    properties: {
      title: "Ключевые свойства",
      items: [
        "Бесконечная масштабируемость: O(1) обновлений на хоп vs O(n) broadcast",
        "Нет проблемы входящей ликвидности: гибрид кредита + залога",
        "Ограниченный риск: потери контрагента ограничены залогом + кредитом",
        "Сильная приватность: onion-routing (отправитель/получатель анонимны для хабов, как Tor для денег)",
        "<strong>Локальное состояние: нет секвенсеров, нет зависимостей от data availability</strong>"
      ]
    },
    tripleS: {
      title: "Три принципа: Triple-S",
      scalable: {
        title: "Масштабируемо",
        desc: "<strong>Unicast (1-к-1)</strong> архитектура обеспечивает неограниченное горизонтальное масштабирование. Никаких broadcast-узких мест, никаких задержек глобального консенсуса.",
        detail1: "O(1) обновлений на хоп vs O(n) broadcast overhead. Контрагенты сами выбирают оптимальные маршруты через коузианские переговоры — от CBDC до кофе, от деревни до планеты.",
        detail2: "Просто нет другого способа масштабироваться на всю планету. Интернет уже доказал: unicast побеждает в глобальном масштабе."
      },
      secure: {
        title: "Безопасно",
        desc: "<strong>Каждый телефон и ноутбук будет полной нодой по умолчанию.</strong> Без компромиссов.",
        detail1: "L1 блокчейны обрабатывают только финальный неттинг — не каждую покупку кофе. Такая ультра-низкая нагрузка означает: даже телефоны могут верифицировать всю цепочку. State pruning минимизирует хранение: полная верификация, не полная история. Никаких light clients, никаких trust assumptions.",
        detail2: "Это реализует оригинальное видение Сатоши и Виталика: суверенная верификация без доверенных посредников. Твои ключи, твоя нода, твои правила."
      },
      simple: {
        title: "Просто",
        desc: "<strong>Банкинг 2.0</strong> без изобретения новой терминологии.",
        detail1: "Кредит, залог, резервы, переводы. Концепции, которые вы уже знаете. Никаких zkSNARK для понимания, никаких merkle trees для аудита. Просто финансы, но программируемые.",
        detail2: "Сложность скрыта в протоколе. Простота видна пользователям. Так масштабировался интернет — так будут масштабироваться финансы."
      }
    },
    roadmap: {
      title: "Дорожная карта",
      q4_2025: { quarter: "Q4 2025", title: "Завершение дизайна протокола", items: ["Финализация архитектуры runtime", "Спецификация билатерального консенсуса", "Дизайн смарт-контрактов"] },
      q1_2026: { quarter: "Q1 2026", title: "Запуск Testnet", items: ["Деплой на Ethereum Sepolia", "Песочница для разработчиков с демо-сущностями", "Публичная документация API"] },
      q2_2026: { quarter: "Q2 2026", title: "Multi-Chain расширение", items: ["Поддержка Arbitrum, Optimism, Base", "Демо кросс-чейн расчётов", "Публикация бенчмарков производительности"] },
      q3_2026: { quarter: "Q3 2026", title: "Аудиты и Mainnet Beta", items: ["Сторонние аудиты безопасности", "Запуск bug bounty программы", "Mainnet beta с whitelisted сущностями"] },
      q4_2026: { quarter: "Q4 2026", title: "Публичный Mainnet", items: ["Открытая регистрация сущностей", "Production SDK (TypeScript, Python)", "Активация governance framework"] },
      future: { quarter: "2027+", title: "Слой интеграции CBDC", items: ["Партнёрства с центральными банками", "Программируемый CBDC субстрат", "Универсальный протокол interop"] }
    },
    newsletter: {
      title: "Присоединяйтесь к Unicast революции",
      subtitle: "Узнавайте о запуске mainnet, технических deep-dives и обновлениях протокола",
      placeholder: "ваш@email.com",
      button: "Подписаться",
      note: "Без спама. Отписка в любое время."
    },
    cbdc: {
      title: "Универсальный субстрат для CBDC",
      intro: "xln — это не просто «лучшие платёжные каналы» — это слой расчётов для программируемых денег планетарного масштаба.",
      today: "<strong>Сегодня:</strong> Универсальный EVM субстрат — работает с любой EVM цепью (Ethereum L1, rollups, alt-L1s: Polygon, Arbitrum, Base, BSC и т.д.)",
      tomorrow: "<strong>Завтра:</strong> Тот же субстрат обслуживает CBDC — когда центральные банки запустят EVM-совместимые программируемые деньги, xln станет универсальным слоем interop",
      countries: "стран",
      pilot: "в пилотной фазе",
      gdp: "мирового ВВП",
      building: "создают программируемые реестры",
      vision: "Большинство будут EVM-совместимы. xln подключается к <strong>любому</strong> программируемому реестру через деплой <code>Depository.sol</code>."
    },
    invite: {
      placeholder: "Код доступа",
      button: "Открыть",
      invalid: "Неверный код"
    }
  }
} as const;

export type ContentLang = keyof typeof content;
export type Content = typeof content.en;
