/**
 * Landing Page Content - All 10 language translations
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
  },
  zh: {
    hero: {
      title: "一个协议。覆盖所有司法管辖区。支持所有可编程账本。",
      subtitle: "面向全球结算的通用CBDC基础设施"
    },
    founder: {
      quote: "在审计支付系统和区块链13年后，我构建了一直期望存在的协议。",
      signature: "Egor Homakov"
    },
    problem: {
      title: "137个国家正在构建可编程货币",
      intro: "CBDC、稳定币、代币化资产——全球98%的GDP正在走向可编程化。100万亿美元的问题不是可编程账本<em>是否</em>会胜出，而是<strong>如何在没有托管方的情况下扩展</strong>。",
      vision: "现有的所有解决方案在全球规模上都失败了：",
      tradfi: "<strong>传统金融/CEX（传统银行、Binance、Coinbase）：</strong>100万亿美元经济体，日交易量10万亿美元，但托管模式——银行救助、FTX崩溃、Mt. Gox",
      bigBlocks: "<strong>所有大区块链（Solana、Tron、BSC）：</strong>市值超800亿美元，但无法运行全节点——设计上就是中心化的",
      rollups: "<strong>所有Rollup（Arbitrum、Optimism、zkSync、StarkNet）：</strong>TVL超100亿美元，但数据可用性悖论——信任第三方委员会、临时calldata或昂贵的blobspace。DA/验证者困境在数学上无解：无法同时拥有廉价验证、永久数据和零信任假设。这是一个二难困境，而非权衡。",
      sharding: "<strong>分片链（NEAR、TON、Zilliqa、MultiversX）：</strong>分片内仍然是O(n)广播——没有解决根本瓶颈。安全性稀释意味着一个分片被攻破，整个网络都面临风险。",
      fcuan: "几个世纪以来，金融运行在<strong>全信用不可证明账户网络（FCUAN）</strong>上：传统银行、CEX、经纪商。纯信用扩展性极佳但安全性弱——资产可被没收，枢纽可能违约。",
      frpap: "2015年，闪电网络引入了<strong>全储备可证明账户原语（FRPAP）</strong>：带密码学证明的支付通道。完全安全但碰到<em>入站流动性墙</em>——这是架构限制，不是bug。Lightning、Raiden、Connext、Celer——所有支付通道项目都已死亡或转型。"
    },
    solution: {
      title: "解决方案",
      intro: "<strong>xln</strong>是第一个<strong>储备-信用可证明账户网络（RCPAN）</strong>：在需要扩展的地方使用信用，在需要安全的地方使用抵押。原则性混合方案。",
      evolution: "结算的演进",
      fcuanDesc: "银行业。纯信用，主导7000年。",
      frpapDesc: "闪电网络。失败（流动性墙）。",
      rcpanDesc: "<strong>xln：</strong>银行业 + 闪电网络 = RCPAN。逻辑终点。"
    },
    whyNow: {
      title: "为什么是现在？",
      items: [
        "<strong>2025：</strong>72个CBDC处于试点阶段",
        "<strong>2026：</strong>跨境CBDC互操作成为政治要务",
        "<strong>传统轨道不兼容：</strong>SWIFT和代理银行无法处理可编程货币",
        "<strong>窗口正在关闭：</strong>每个构建不兼容扩展方案的CBDC都会造成永久碎片化",
        "<strong>现在就需要通用基础设施：</strong>趁标准尚未固化"
      ]
    },
    contracts: {
      title: "模块化合约系统",
      subtitle: "整个金融系统如同可插拔的乐高积木。部署你自己的。永远可扩展。",
      note: "<strong>Depository</strong> = 不可变信任锚。<strong>模块</strong> = 可热插拔实现。随时部署<code>YourCustomEntityProvider.sol</code>。"
    },
    properties: {
      title: "核心特性",
      items: [
        "无限可扩展性：每跳O(1)更新 vs O(n)广播",
        "无入站流动性问题：信用 + 抵押混合",
        "有限风险：对手方损失上限为抵押 + 信用",
        "强隐私：洋葱路由（支付发送方/接收方对路由枢纽匿名，如同货币版Tor）",
        "<strong>本地状态：无排序器，无数据可用性依赖</strong>"
      ]
    },
    tripleS: {
      title: "Triple-S第一性原理",
      scalable: {
        title: "可扩展",
        desc: "<strong>单播（1对1）</strong>架构实现无限水平扩展。无广播瓶颈，无全球共识延迟。",
        detail1: "每跳O(1)更新 vs O(n)广播开销。交易对手通过科斯式谈判自主选择最优路由路径——从CBDC到咖啡，从村庄到全球。",
        detail2: "扩展到整个星球别无他法。互联网已证明单播在全球规模上胜出。"
      },
      secure: {
        title: "安全",
        desc: "<strong>每部手机和笔记本电脑默认都是全节点。</strong>不可妥协。",
        detail1: "L1区块链仅处理最终净额结算——不是每次咖啡购买。这种超低结算负载意味着连手机都能验证整条链。状态修剪最小化存储：完整验证，而非完整历史。无轻客户端，无信任假设。",
        detail2: "这实现了中本聪和Vitalik的原始愿景：无需可信中介的自主权验证。你的密钥，你的节点，你的规则。"
      },
      simple: {
        title: "简单",
        desc: "<strong>银行业2.0</strong>，零新术语发明。",
        detail1: "信用、抵押、储备、转账。你已经知道的概念。无需理解zkSNARKs，无需审计Merkle树。只是可编程的金融。",
        detail2: "复杂性隐藏在协议中。简洁性呈现给用户。这就是互联网的扩展方式——也是金融将要扩展的方式。"
      }
    },
    roadmap: {
      title: "路线图",
      q4_2025: { quarter: "2025 Q4", title: "协议设计完成", items: ["运行时架构定稿", "双边共识规范", "智能合约设计"] },
      q1_2026: { quarter: "2026 Q1", title: "测试网启动", items: ["部署至Ethereum Sepolia", "开发者沙箱与演示实体", "公开API文档"] },
      q2_2026: { quarter: "2026 Q2", title: "多链扩展", items: ["支持Arbitrum、Optimism、Base", "跨链结算演示", "发布性能基准"] },
      q3_2026: { quarter: "2026 Q3", title: "安全审计与主网测试版", items: ["第三方安全审计", "启动漏洞赏金计划", "白名单实体主网测试版"] },
      q4_2026: { quarter: "2026 Q4", title: "公开主网", items: ["开放实体注册", "生产级SDK（TypeScript、Python）", "激活治理框架"] },
      future: { quarter: "2027+", title: "CBDC集成层", items: ["与中央银行合作", "可编程CBDC基础设施", "通用互操作协议"] }
    },
    newsletter: {
      title: "加入单播革命",
      subtitle: "获取主网启动、技术深度解析和协议更新通知",
      placeholder: "your@email.com",
      button: "订阅",
      note: "无垃圾邮件。随时退订。"
    },
    cbdc: {
      title: "通用CBDC基础设施",
      intro: "xln不仅仅是「更好的支付通道」——它是全球规模可编程货币的结算层。",
      today: "<strong>今天：</strong>通用EVM基础设施——支持任何EVM链（Ethereum L1、rollups、alt-L1s：Polygon、Arbitrum、Base、BSC等）",
      tomorrow: "<strong>明天：</strong>同一基础设施服务CBDC——当中央银行推出EVM兼容的可编程货币时，xln成为通用互操作层",
      countries: "个国家",
      pilot: "处于试点阶段",
      gdp: "全球GDP",
      building: "正在构建可编程账本",
      vision: "大多数将兼容EVM。xln通过部署<code>Depository.sol</code>连接<strong>任何</strong>可编程账本。"
    },
    invite: {
      placeholder: "访问码",
      button: "解锁",
      invalid: "无效代码"
    }
  },
  es: {
    hero: {
      title: "Un protocolo. Cada jurisdicción. Cada libro mayor programable.",
      subtitle: "El sustrato universal de CBDC para liquidación a escala planetaria"
    },
    founder: {
      quote: "Después de 13 años auditando sistemas de pago y blockchains, construí el protocolo que siempre deseé que existiera.",
      signature: "Egor Homakov"
    },
    problem: {
      title: "137 países están construyendo dinero programable",
      intro: "CBDCs, stablecoins, activos tokenizados—el 98% del PIB global se está volviendo programable. La pregunta de $100 billones no es <em>si</em> los libros mayores programables ganan. Es <strong>cómo escalan sin custodios</strong>.",
      vision: "Todas las respuestas existentes fallan a escala planetaria:",
      tradfi: "<strong>TradFi/CEX (bancos tradicionales, Binance, Coinbase):</strong> economía de $100T, $10T de volumen diario, pero custodial — rescates bancarios, colapso de FTX, Mt. Gox",
      bigBlocks: "<strong>Todos los big blockers (Solana, Tron, BSC):</strong> +$80B de capitalización, pero no pueden ejecutar nodos completos — centralizados por diseño",
      rollups: "<strong>Todos los rollups (Arbitrum, Optimism, zkSync, StarkNet):</strong> +$10B TVL, pero paradoja de disponibilidad de datos — confía en comités, calldata efímera o blobspace costoso. El dilema DA/verificador es matemáticamente irresoluble: no puedes tener verificación barata, datos permanentes y cero suposiciones de confianza simultáneamente. Es un catch-22, no un tradeoff.",
      sharding: "<strong>Cadenas de sharding (NEAR, TON, Zilliqa, MultiversX):</strong> Aún broadcast O(n) dentro de shards — no resuelve el cuello de botella fundamental. La dilución de seguridad significa que un shard comprometido pone en riesgo toda la red.",
      fcuan: "Durante siglos, las finanzas funcionaron con <strong>Redes de Cuentas de Crédito Total No Comprobables (FCUAN)</strong>: banca tradicional, CEXs, brokers. El crédito puro escala fenomenalmente pero ofrece seguridad débil—los activos pueden ser confiscados, los hubs pueden quebrar.",
      frpap: "En 2015, Lightning introdujo <strong>Primitivas de Cuentas Comprobables de Reserva Total (FRPAP)</strong>: canales de pago con pruebas criptográficas. Seguridad total pero choca con el <em>muro de liquidez entrante</em>—un límite arquitectónico, no un bug. Lightning, Raiden, Connext, Celer — todos los proyectos de canales de pago están muertos o han pivotado."
    },
    solution: {
      title: "La Solución",
      intro: "<strong>xln</strong> es la primera <strong>Red de Cuentas Comprobables de Reserva-Crédito (RCPAN)</strong>: crédito donde escala, colateral donde asegura. Un híbrido con principios.",
      evolution: "La Evolución de la Liquidación",
      fcuanDesc: "Banca. Crédito puro, 7000 años dominante.",
      frpapDesc: "Lightning. Falló (muro de liquidez).",
      rcpanDesc: "<strong>xln:</strong> Banca + Lightning = RCPAN. El final lógico."
    },
    whyNow: {
      title: "¿Por qué ahora?",
      items: [
        "<strong>2025:</strong> 72 CBDCs en fase piloto",
        "<strong>2026:</strong> La interoperabilidad transfronteriza de CBDC se convierte en imperativo político",
        "<strong>Rieles legacy incompatibles:</strong> SWIFT y la banca corresponsal no pueden manejar dinero programable",
        "<strong>La ventana se cierra:</strong> Cada CBDC construyendo soluciones incompatibles crea fragmentación permanente",
        "<strong>Se necesita sustrato universal AHORA:</strong> Antes de que los estándares se osifiquen"
      ]
    },
    contracts: {
      title: "Sistema de Contratos Modular",
      subtitle: "Todo el sistema financiero como ladrillos Lego enchufables. Despliega los tuyos. Extiende para siempre.",
      note: "<strong>Depository</strong> = ancla de confianza inmutable. <strong>Módulos</strong> = implementaciones intercambiables en caliente. Despliega <code>YourCustomEntityProvider.sol</code> cuando quieras."
    },
    properties: {
      title: "Propiedades Clave",
      items: [
        "Escalabilidad infinita: actualizaciones O(1) por salto vs broadcast O(n)",
        "Sin problema de liquidez entrante: híbrido crédito + colateral",
        "Riesgo acotado: pérdida de contraparte limitada a colateral + crédito",
        "Privacidad fuerte: enrutamiento cebolla (emisor/receptor anónimos para hubs de enrutamiento, como Tor para dinero)",
        "<strong>Estado local: sin secuenciadores, sin dependencias de disponibilidad de datos</strong>"
      ]
    },
    tripleS: {
      title: "Principios Fundamentales Triple-S",
      scalable: {
        title: "Escalable",
        desc: "Arquitectura <strong>Unicast (1-a-1)</strong> permite escalado horizontal ilimitado. Sin cuellos de botella de broadcast, sin retrasos de consenso global.",
        detail1: "Actualizaciones O(1) por salto vs overhead de broadcast O(n). Las contrapartes auto-seleccionan rutas óptimas mediante negociación Coasiana — desde CBDCs hasta café, de pueblo a globo.",
        detail2: "Simplemente no hay otra forma de escalar a todo el planeta. Internet ya demostró que unicast gana a escala global."
      },
      secure: {
        title: "Seguro",
        desc: "<strong>Cada teléfono y laptop será un nodo completo por defecto.</strong> No negociable.",
        detail1: "Las blockchains L1 solo manejan el neteo final — no cada compra de café. Esta carga de liquidación ultra-baja significa que incluso los teléfonos pueden verificar toda la cadena. La poda de estado mantiene el almacenamiento mínimo: verificación completa, no historial completo. Sin clientes ligeros, sin suposiciones de confianza.",
        detail2: "Esto implementa la visión original de Satoshi y Vitalik: verificación soberana sin intermediarios de confianza. Tus llaves, tu nodo, tus reglas."
      },
      simple: {
        title: "Simple",
        desc: "<strong>Banca 2.0</strong> sin inventar nueva terminología.",
        detail1: "Crédito, colateral, reservas, transferencias. Conceptos que ya conoces. Sin zkSNARKs que entender, sin árboles merkle que auditar. Solo finanzas, pero programables.",
        detail2: "Complejidad oculta en el protocolo. Simplicidad expuesta a usuarios. Así escaló internet — y así escalará las finanzas."
      }
    },
    roadmap: {
      title: "Hoja de Ruta",
      q4_2025: { quarter: "Q4 2025", title: "Diseño del Protocolo Completo", items: ["Arquitectura de runtime finalizada", "Especificación de consenso bilateral", "Diseño de contratos inteligentes"] },
      q1_2026: { quarter: "Q1 2026", title: "Lanzamiento de Testnet", items: ["Despliegue en Ethereum Sepolia", "Sandbox para desarrolladores con entidades demo", "Documentación pública de API"] },
      q2_2026: { quarter: "Q2 2026", title: "Expansión Multi-Cadena", items: ["Soporte para Arbitrum, Optimism, Base", "Demos de liquidación cross-chain", "Benchmarks de rendimiento publicados"] },
      q3_2026: { quarter: "Q3 2026", title: "Auditorías de Seguridad y Mainnet Beta", items: ["Auditorías de seguridad externas", "Lanzamiento de programa bug bounty", "Mainnet beta con entidades whitelisted"] },
      q4_2026: { quarter: "Q4 2026", title: "Mainnet Público", items: ["Registro abierto de entidades", "SDKs de producción (TypeScript, Python)", "Activación del framework de gobernanza"] },
      future: { quarter: "2027+", title: "Capa de Integración CBDC", items: ["Asociaciones con bancos centrales", "Sustrato programable CBDC", "Protocolo de interoperabilidad universal"] }
    },
    newsletter: {
      title: "Únete a la Revolución Unicast",
      subtitle: "Recibe notificaciones sobre el lanzamiento de mainnet, análisis técnicos profundos y actualizaciones del protocolo",
      placeholder: "tu@email.com",
      button: "Suscribirse",
      note: "Sin spam. Cancela cuando quieras."
    },
    cbdc: {
      title: "El Sustrato Universal para CBDC",
      intro: "xln no es solo \"mejores canales de pago\" — es la capa de liquidación para dinero programable a escala planetaria.",
      today: "<strong>Hoy:</strong> Sustrato EVM universal — funciona con cualquier cadena EVM (Ethereum L1, rollups, alt-L1s: Polygon, Arbitrum, Base, BSC, etc.)",
      tomorrow: "<strong>Mañana:</strong> El mismo sustrato sirve a CBDCs — cuando los bancos centrales lancen dinero programable compatible con EVM, xln se convierte en la capa de interoperabilidad universal",
      countries: "países",
      pilot: "en fase piloto",
      gdp: "del PIB global",
      building: "construyendo libros mayores programables",
      vision: "La mayoría serán compatibles con EVM. xln se conecta a <strong>cualquier</strong> libro mayor programable desplegando <code>Depository.sol</code>."
    },
    invite: {
      placeholder: "Código de Acceso",
      button: "Desbloquear",
      invalid: "Código inválido"
    }
  },
  ja: {
    hero: {
      title: "一つのプロトコル。すべての法域。すべてのプログラマブル台帳。",
      subtitle: "惑星規模の決済のためのユニバーサルCBDC基盤"
    },
    founder: {
      quote: "決済システムとブロックチェーンを13年間監査した後、ずっと存在してほしかったプロトコルを構築しました。",
      signature: "Egor Homakov"
    },
    problem: {
      title: "137カ国がプログラマブルマネーを構築中",
      intro: "CBDC、ステーブルコイン、トークン化資産——世界GDPの98%がプログラマブル化へ。100兆ドルの問題は、プログラマブル台帳が勝つ<em>かどうか</em>ではありません。<strong>カストディアンなしでどうスケールするか</strong>です。",
      vision: "既存のすべての解決策は惑星規模で失敗します：",
      tradfi: "<strong>TradFi/CEX（伝統的銀行、Binance、Coinbase）：</strong>100兆ドル経済、日次取引量10兆ドル、しかしカストディアル——銀行救済、FTX崩壊、Mt. Gox",
      bigBlocks: "<strong>すべてのビッグブロッカー（Solana、Tron、BSC）：</strong>時価総額800億ドル以上、しかしフルノードを実行できない——設計上中央集権的",
      rollups: "<strong>すべてのロールアップ（Arbitrum、Optimism、zkSync、StarkNet）：</strong>TVL100億ドル以上、しかしデータ可用性パラドックス——サードパーティ委員会、一時的なcalldata、高価なblobspaceを信頼。DA/検証者ジレンマは数学的に解決不可能：安価な検証、永続データ、信頼前提ゼロを同時に持つことはできません。トレードオフではなくcatch-22です。",
      sharding: "<strong>シャーディングチェーン（NEAR、TON、Zilliqa、MultiversX）：</strong>シャード内でO(n)ブロードキャスト——根本的なボトルネックを解決していません。セキュリティ希釈は、1つのシャードが侵害されるとネットワーク全体がリスクにさらされることを意味します。",
      fcuan: "何世紀もの間、金融は<strong>フルクレジット検証不能アカウントネットワーク（FCUAN）</strong>で運営されてきました：伝統的銀行、CEX、ブローカー。純粋なクレジットは驚異的にスケールしますが、セキュリティが弱い——資産は差し押さえられ、ハブはデフォルトする可能性があります。",
      frpap: "2015年、Lightningは<strong>フルリザーブ検証可能アカウントプリミティブ（FRPAP）</strong>を導入しました：暗号証明付きの支払いチャネル。完全なセキュリティですが<em>インバウンド流動性の壁</em>にぶつかります——これはバグではなくアーキテクチャの限界です。Lightning、Raiden、Connext、Celer——すべての支払いチャネルプロジェクトは死亡または方向転換しました。"
    },
    solution: {
      title: "ソリューション",
      intro: "<strong>xln</strong>は最初の<strong>リザーブ-クレジット検証可能アカウントネットワーク（RCPAN）</strong>です：スケールが必要な場所にクレジット、セキュリティが必要な場所に担保。原則的なハイブリッド。",
      evolution: "決済の進化",
      fcuanDesc: "銀行業。純粋なクレジット、7000年の支配。",
      frpapDesc: "Lightning。失敗（流動性の壁）。",
      rcpanDesc: "<strong>xln：</strong>銀行業 + Lightning = RCPAN。論理的な終着点。"
    },
    whyNow: {
      title: "なぜ今なのか？",
      items: [
        "<strong>2025：</strong>72のCBDCがパイロット段階",
        "<strong>2026：</strong>クロスボーダーCBDC相互運用性が政治的必須事項に",
        "<strong>レガシーレールは非互換：</strong>SWIFTとコルレス銀行はプログラマブルマネーを処理できない",
        "<strong>ウィンドウが閉じつつある：</strong>互換性のないスケーリングソリューションを構築する各CBDCが永続的な断片化を生む",
        "<strong>ユニバーサル基盤が今必要：</strong>標準が固まる前に"
      ]
    },
    contracts: {
      title: "モジュラーコントラクトシステム",
      subtitle: "金融システム全体がプラグ可能なレゴブロックとして。独自のものをデプロイ。永遠に拡張。",
      note: "<strong>Depository</strong> = 不変の信頼アンカー。<strong>モジュール</strong> = ホットスワップ可能な実装。<code>YourCustomEntityProvider.sol</code>をいつでもデプロイ。"
    },
    properties: {
      title: "主要な特性",
      items: [
        "無限のスケーラビリティ：ホップごとO(1)更新 vs O(n)ブロードキャスト",
        "インバウンド流動性問題なし：クレジット + 担保ハイブリッド",
        "限定されたリスク：カウンターパーティ損失は担保 + クレジットが上限",
        "強力なプライバシー：オニオンルーティング（支払い送信者/受信者はルーティングハブに対して匿名、マネー版Tor）",
        "<strong>ローカルステート：シーケンサーなし、データ可用性依存なし</strong>"
      ]
    },
    tripleS: {
      title: "Triple-S 第一原理",
      scalable: {
        title: "スケーラブル",
        desc: "<strong>ユニキャスト（1対1）</strong>アーキテクチャが無限の水平スケーリングを可能にします。ブロードキャストボトルネックなし、グローバルコンセンサス遅延なし。",
        detail1: "ホップごとO(1)更新 vs O(n)ブロードキャストオーバーヘッド。カウンターパーティがコースィアン交渉を通じて最適なルーティングパスを自己選択——CBDCからコーヒーまで、村から地球まで。",
        detail2: "惑星全体にスケールする他の方法は単純にありません。インターネットはすでにユニキャストがグローバルスケールで勝つことを証明しました。"
      },
      secure: {
        title: "セキュア",
        desc: "<strong>すべての電話とラップトップがデフォルトでフルノードになります。</strong>妥協なし。",
        detail1: "L1ブロックチェーンは最終ネッティングのみを処理——すべてのコーヒー購入ではありません。この超低決済負荷は、電話でさえチェーン全体を検証できることを意味します。ステートプルーニングがストレージを最小に保つ：完全な検証、完全な履歴ではない。ライトクライアントなし、信頼前提なし。",
        detail2: "これはサトシとヴィタリックのオリジナルビジョンを実装します：信頼できる仲介者なしの自己主権検証。あなたの鍵、あなたのノード、あなたのルール。"
      },
      simple: {
        title: "シンプル",
        desc: "<strong>バンキング2.0</strong>、新しい用語の発明ゼロ。",
        detail1: "クレジット、担保、リザーブ、送金。すでに知っている概念。理解すべきzkSNARKsなし、監査すべきマークルツリーなし。単にプログラマブルな金融。",
        detail2: "複雑さはプロトコルに隠される。シンプルさはユーザーに公開される。インターネットがそうやってスケールした——金融もそうやってスケールする。"
      }
    },
    roadmap: {
      title: "ロードマップ",
      q4_2025: { quarter: "2025年Q4", title: "プロトコル設計完了", items: ["ランタイムアーキテクチャ確定", "バイラテラルコンセンサス仕様", "スマートコントラクト設計"] },
      q1_2026: { quarter: "2026年Q1", title: "テストネット開始", items: ["Ethereum Sepoliaにデプロイ", "デモエンティティ付き開発者サンドボックス", "公開API文書"] },
      q2_2026: { quarter: "2026年Q2", title: "マルチチェーン展開", items: ["Arbitrum、Optimism、Baseサポート", "クロスチェーン決済デモ", "パフォーマンスベンチマーク公開"] },
      q3_2026: { quarter: "2026年Q3", title: "セキュリティ監査とメインネットベータ", items: ["サードパーティセキュリティ監査", "バグバウンティプログラム開始", "ホワイトリストエンティティでのメインネットベータ"] },
      q4_2026: { quarter: "2026年Q4", title: "パブリックメインネット", items: ["オープンエンティティ登録", "プロダクショングレードSDK（TypeScript、Python）", "ガバナンスフレームワーク有効化"] },
      future: { quarter: "2027年以降", title: "CBDC統合レイヤー", items: ["中央銀行とのパートナーシップ", "プログラマブルCBDC基盤", "ユニバーサル相互運用プロトコル"] }
    },
    newsletter: {
      title: "ユニキャスト革命に参加",
      subtitle: "メインネット開始、技術的詳細分析、プロトコルアップデートの通知を受け取る",
      placeholder: "your@email.com",
      button: "購読",
      note: "スパムなし。いつでも解除可能。"
    },
    cbdc: {
      title: "ユニバーサルCBDC基盤",
      intro: "xlnは単なる「より良い支払いチャネル」ではありません——惑星規模のプログラマブルマネーのための決済レイヤーです。",
      today: "<strong>今日：</strong>ユニバーサルEVM基盤——あらゆるEVMチェーンで動作（Ethereum L1、rollups、alt-L1s：Polygon、Arbitrum、Base、BSCなど）",
      tomorrow: "<strong>明日：</strong>同じ基盤がCBDCにサービス——中央銀行がEVM互換のプログラマブルマネーを開始すると、xlnがユニバーサル相互運用レイヤーになります",
      countries: "カ国",
      pilot: "がパイロット段階",
      gdp: "の世界GDP",
      building: "がプログラマブル台帳を構築中",
      vision: "ほとんどがEVM互換になります。xlnは<code>Depository.sol</code>をデプロイすることで<strong>あらゆる</strong>プログラマブル台帳に接続します。"
    },
    invite: {
      placeholder: "アクセスコード",
      button: "ロック解除",
      invalid: "無効なコード"
    }
  },
  ko: {
    hero: {
      title: "하나의 프로토콜. 모든 관할권. 모든 프로그래머블 원장.",
      subtitle: "행성 규모 결제를 위한 범용 CBDC 기반"
    },
    founder: {
      quote: "결제 시스템과 블록체인을 13년간 감사한 후, 항상 존재하길 바랐던 프로토콜을 구축했습니다.",
      signature: "Egor Homakov"
    },
    problem: {
      title: "137개국이 프로그래머블 화폐를 구축 중",
      intro: "CBDC, 스테이블코인, 토큰화 자산—전 세계 GDP의 98%가 프로그래머블화되고 있습니다. 100조 달러 문제는 프로그래머블 원장이 <em>이길지</em>가 아닙니다. <strong>수탁자 없이 어떻게 확장하는가</strong>입니다.",
      vision: "기존의 모든 답변은 행성 규모에서 실패합니다:",
      tradfi: "<strong>TradFi/CEX (전통 은행, Binance, Coinbase):</strong> 100조 달러 경제, 일일 거래량 10조 달러, 하지만 수탁 모델 — 은행 구제, FTX 붕괴, Mt. Gox",
      bigBlocks: "<strong>모든 빅 블로커 (Solana, Tron, BSC):</strong> 시가총액 800억 달러 이상, 하지만 풀 노드 실행 불가 — 설계상 중앙집중화",
      rollups: "<strong>모든 롤업 (Arbitrum, Optimism, zkSync, StarkNet):</strong> TVL 100억 달러 이상, 하지만 데이터 가용성 역설 — 제3자 위원회, 임시 calldata, 비싼 blobspace를 신뢰. DA/검증자 딜레마는 수학적으로 해결 불가능: 저렴한 검증, 영구 데이터, 신뢰 가정 제로를 동시에 가질 수 없습니다. 트레이드오프가 아닌 catch-22입니다.",
      sharding: "<strong>샤딩 체인 (NEAR, TON, Zilliqa, MultiversX):</strong> 샤드 내에서 여전히 O(n) 브로드캐스트 — 근본적 병목을 해결하지 못함. 보안 희석은 하나의 샤드가 침해되면 전체 네트워크가 위험에 처한다는 의미입니다.",
      fcuan: "수세기 동안 금융은 <strong>풀 크레딧 증명불가 계정 네트워크(FCUAN)</strong>에서 운영되었습니다: 전통 은행, CEX, 브로커. 순수 신용은 놀랍게 확장되지만 보안이 약합니다—자산이 압류될 수 있고, 허브가 부도날 수 있습니다.",
      frpap: "2015년, 라이트닝이 <strong>풀 리저브 증명가능 계정 프리미티브(FRPAP)</strong>를 도입했습니다: 암호학적 증명이 있는 결제 채널. 완전한 보안이지만 <em>인바운드 유동성 벽</em>에 부딪힙니다—이것은 버그가 아닌 아키텍처 한계입니다. Lightning, Raiden, Connext, Celer — 모든 결제 채널 프로젝트가 사망하거나 피벗했습니다."
    },
    solution: {
      title: "솔루션",
      intro: "<strong>xln</strong>은 최초의 <strong>리저브-크레딧 증명가능 계정 네트워크(RCPAN)</strong>입니다: 확장이 필요한 곳에 신용, 보안이 필요한 곳에 담보. 원칙적 하이브리드.",
      evolution: "결제의 진화",
      fcuanDesc: "은행업. 순수 신용, 7000년 지배.",
      frpapDesc: "라이트닝. 실패 (유동성 벽).",
      rcpanDesc: "<strong>xln:</strong> 은행업 + 라이트닝 = RCPAN. 논리적 종착점."
    },
    whyNow: {
      title: "왜 지금인가?",
      items: [
        "<strong>2025:</strong> 72개 CBDC가 파일럿 단계",
        "<strong>2026:</strong> 국경간 CBDC 상호운용성이 정치적 과제로",
        "<strong>레거시 레일 비호환:</strong> SWIFT와 환거래 은행이 프로그래머블 화폐 처리 불가",
        "<strong>윈도우 닫히는 중:</strong> 비호환 스케일링 솔루션을 구축하는 각 CBDC가 영구적 분열 생성",
        "<strong>범용 기반이 지금 필요:</strong> 표준이 굳어지기 전에"
      ]
    },
    contracts: {
      title: "모듈형 컨트랙트 시스템",
      subtitle: "플러그 가능한 레고 블록으로서의 전체 금융 시스템. 자체 배포. 영원히 확장.",
      note: "<strong>Depository</strong> = 불변의 신뢰 앵커. <strong>모듈</strong> = 핫스왑 가능한 구현. <code>YourCustomEntityProvider.sol</code>을 언제든지 배포."
    },
    properties: {
      title: "핵심 속성",
      items: [
        "무한한 확장성: 홉당 O(1) 업데이트 vs O(n) 브로드캐스트",
        "인바운드 유동성 문제 없음: 신용 + 담보 하이브리드",
        "제한된 위험: 상대방 손실이 담보 + 신용으로 상한",
        "강력한 프라이버시: 어니언 라우팅 (결제 발신자/수신자가 라우팅 허브에 익명, 돈을 위한 Tor처럼)",
        "<strong>로컬 상태: 시퀀서 없음, 데이터 가용성 의존성 없음</strong>"
      ]
    },
    tripleS: {
      title: "Triple-S 제1원칙",
      scalable: {
        title: "확장 가능",
        desc: "<strong>유니캐스트 (1대1)</strong> 아키텍처가 무제한 수평 확장을 가능하게 합니다. 브로드캐스트 병목 없음, 글로벌 합의 지연 없음.",
        detail1: "홉당 O(1) 업데이트 vs O(n) 브로드캐스트 오버헤드. 상대방들이 코즈식 협상을 통해 최적 라우팅 경로를 자체 선택 — CBDC에서 커피까지, 마을에서 지구까지.",
        detail2: "행성 전체로 확장하는 다른 방법은 없습니다. 인터넷은 이미 유니캐스트가 글로벌 스케일에서 승리함을 증명했습니다."
      },
      secure: {
        title: "안전",
        desc: "<strong>모든 폰과 노트북이 기본적으로 풀 노드가 됩니다.</strong> 비타협적.",
        detail1: "L1 블록체인은 최종 네팅만 처리 — 모든 커피 구매가 아님. 이 초저 결제 부하는 폰조차 전체 체인을 검증할 수 있음을 의미합니다. 상태 프루닝이 스토리지를 최소화: 완전한 검증, 완전한 히스토리가 아님. 라이트 클라이언트 없음, 신뢰 가정 없음.",
        detail2: "이것은 사토시와 비탈릭의 원래 비전을 구현합니다: 신뢰할 수 있는 중개자 없는 자기주권 검증. 당신의 키, 당신의 노드, 당신의 규칙."
      },
      simple: {
        title: "단순",
        desc: "<strong>뱅킹 2.0</strong>, 새로운 용어 발명 제로.",
        detail1: "신용, 담보, 준비금, 전송. 이미 알고 있는 개념들. 이해할 zkSNARKs 없음, 감사할 머클 트리 없음. 그냥 프로그래머블 금융.",
        detail2: "복잡성은 프로토콜에 숨겨집니다. 단순성이 사용자에게 노출됩니다. 인터넷이 그렇게 확장했고 — 금융도 그렇게 확장할 것입니다."
      }
    },
    roadmap: {
      title: "로드맵",
      q4_2025: { quarter: "2025년 4분기", title: "프로토콜 설계 완료", items: ["런타임 아키텍처 확정", "양자 합의 사양", "스마트 컨트랙트 설계"] },
      q1_2026: { quarter: "2026년 1분기", title: "테스트넷 출시", items: ["Ethereum Sepolia에 배포", "데모 엔티티가 있는 개발자 샌드박스", "공개 API 문서"] },
      q2_2026: { quarter: "2026년 2분기", title: "멀티체인 확장", items: ["Arbitrum, Optimism, Base 지원", "크로스체인 결제 데모", "성능 벤치마크 게시"] },
      q3_2026: { quarter: "2026년 3분기", title: "보안 감사 및 메인넷 베타", items: ["제3자 보안 감사", "버그 바운티 프로그램 출시", "화이트리스트 엔티티와 메인넷 베타"] },
      q4_2026: { quarter: "2026년 4분기", title: "퍼블릭 메인넷", items: ["오픈 엔티티 등록", "프로덕션 등급 SDK (TypeScript, Python)", "거버넌스 프레임워크 활성화"] },
      future: { quarter: "2027+", title: "CBDC 통합 레이어", items: ["중앙은행과 파트너십", "프로그래머블 CBDC 기반", "범용 상호운용 프로토콜"] }
    },
    newsletter: {
      title: "유니캐스트 혁명에 참여하세요",
      subtitle: "메인넷 출시, 기술 심층 분석, 프로토콜 업데이트 알림 받기",
      placeholder: "your@email.com",
      button: "구독",
      note: "스팸 없음. 언제든 구독 해지 가능."
    },
    cbdc: {
      title: "범용 CBDC 기반",
      intro: "xln은 단순히 \"더 나은 결제 채널\"이 아닙니다 — 행성 규모 프로그래머블 화폐를 위한 결제 레이어입니다.",
      today: "<strong>오늘:</strong> 범용 EVM 기반 — 모든 EVM 체인과 작동 (Ethereum L1, rollups, alt-L1s: Polygon, Arbitrum, Base, BSC 등)",
      tomorrow: "<strong>내일:</strong> 동일한 기반이 CBDC에 서비스 — 중앙은행이 EVM 호환 프로그래머블 화폐를 출시하면, xln이 범용 상호운용 레이어가 됩니다",
      countries: "개국",
      pilot: "이 파일럿 단계",
      gdp: "의 글로벌 GDP",
      building: "가 프로그래머블 원장 구축 중",
      vision: "대부분이 EVM 호환이 될 것입니다. xln은 <code>Depository.sol</code>을 배포하여 <strong>모든</strong> 프로그래머블 원장에 연결됩니다."
    },
    invite: {
      placeholder: "액세스 코드",
      button: "잠금 해제",
      invalid: "잘못된 코드"
    }
  },
  pt: {
    hero: {
      title: "Um protocolo. Todas as jurisdições. Todos os livros-razão programáveis.",
      subtitle: "O substrato universal de CBDC para liquidação em escala planetária"
    },
    founder: {
      quote: "Após 13 anos auditando sistemas de pagamento e blockchains, construí o protocolo que sempre desejei que existisse.",
      signature: "Egor Homakov"
    },
    problem: {
      title: "137 países estão construindo dinheiro programável",
      intro: "CBDCs, stablecoins, ativos tokenizados—98% do PIB global está se tornando programável. A pergunta de $100 trilhões não é <em>se</em> os livros-razão programáveis vencerão. É <strong>como escalam sem custodiantes</strong>.",
      vision: "Todas as respostas existentes falham em escala planetária:",
      tradfi: "<strong>TradFi/CEX (bancos tradicionais, Binance, Coinbase):</strong> economia de $100T, volume diário de $10T, mas custodial — resgates bancários, colapso da FTX, Mt. Gox",
      bigBlocks: "<strong>Todos os big blockers (Solana, Tron, BSC):</strong> +$80B de capitalização, mas não conseguem rodar full nodes — centralizados por design",
      rollups: "<strong>Todos os rollups (Arbitrum, Optimism, zkSync, StarkNet):</strong> +$10B TVL, mas paradoxo de disponibilidade de dados — confie em comitês, calldata efêmera ou blobspace caro. O dilema DA/verificador é matematicamente insolúvel: não é possível ter verificação barata, dados permanentes e zero suposições de confiança simultaneamente. É um catch-22, não um tradeoff.",
      sharding: "<strong>Chains de sharding (NEAR, TON, Zilliqa, MultiversX):</strong> Ainda broadcast O(n) dentro de shards — não resolve o gargalo fundamental. Diluição de segurança significa que um shard comprometido coloca toda a rede em risco.",
      fcuan: "Por séculos, as finanças operaram em <strong>Redes de Contas de Crédito Total Não Prováveis (FCUAN)</strong>: bancos tradicionais, CEXs, corretores. Crédito puro escala fenomenalmente mas oferece segurança fraca—ativos podem ser confiscados, hubs podem dar default.",
      frpap: "Em 2015, Lightning introduziu <strong>Primitivas de Contas Prováveis de Reserva Total (FRPAP)</strong>: canais de pagamento com provas criptográficas. Segurança total mas bate no <em>muro de liquidez de entrada</em>—um limite arquitetônico, não um bug. Lightning, Raiden, Connext, Celer — todos os projetos de canais de pagamento estão mortos ou pivotaram."
    },
    solution: {
      title: "A Solução",
      intro: "<strong>xln</strong> é a primeira <strong>Rede de Contas Prováveis de Reserva-Crédito (RCPAN)</strong>: crédito onde escala, colateral onde protege. Um híbrido com princípios.",
      evolution: "A Evolução da Liquidação",
      fcuanDesc: "Bancos. Crédito puro, 7000 anos dominante.",
      frpapDesc: "Lightning. Falhou (muro de liquidez).",
      rcpanDesc: "<strong>xln:</strong> Bancos + Lightning = RCPAN. O final lógico."
    },
    whyNow: {
      title: "Por que agora?",
      items: [
        "<strong>2025:</strong> 72 CBDCs em fase piloto",
        "<strong>2026:</strong> Interoperabilidade transfronteiriça de CBDC se torna imperativo político",
        "<strong>Rails legacy incompatíveis:</strong> SWIFT e bancos correspondentes não conseguem lidar com dinheiro programável",
        "<strong>Janela fechando:</strong> Cada CBDC construindo soluções de escala incompatíveis cria fragmentação permanente",
        "<strong>Substrato universal necessário AGORA:</strong> Antes que os padrões se ossifiquem"
      ]
    },
    contracts: {
      title: "Sistema de Contratos Modular",
      subtitle: "Todo o sistema financeiro como tijolos Lego plugáveis. Implante os seus. Estenda para sempre.",
      note: "<strong>Depository</strong> = âncora de confiança imutável. <strong>Módulos</strong> = implementações hot-swappable. Implante <code>YourCustomEntityProvider.sol</code> a qualquer momento."
    },
    properties: {
      title: "Propriedades Chave",
      items: [
        "Escalabilidade infinita: atualizações O(1) por hop vs broadcast O(n)",
        "Sem problema de liquidez de entrada: híbrido crédito + colateral",
        "Risco limitado: perda de contraparte limitada a colateral + crédito",
        "Privacidade forte: roteamento cebola (emissor/receptor anônimos para hubs de roteamento, como Tor para dinheiro)",
        "<strong>Estado local: sem sequenciadores, sem dependências de disponibilidade de dados</strong>"
      ]
    },
    tripleS: {
      title: "Princípios Fundamentais Triple-S",
      scalable: {
        title: "Escalável",
        desc: "Arquitetura <strong>Unicast (1-para-1)</strong> permite escala horizontal ilimitada. Sem gargalos de broadcast, sem atrasos de consenso global.",
        detail1: "Atualizações O(1) por hop vs overhead de broadcast O(n). Contrapartes auto-selecionam caminhos de roteamento ótimos através de negociação Coasiana — de CBDCs a café, de vila a globo.",
        detail2: "Simplesmente não há outra forma de escalar para o planeta inteiro. A internet já provou que unicast vence em escala global."
      },
      secure: {
        title: "Seguro",
        desc: "<strong>Cada telefone e laptop será um full node por padrão.</strong> Inegociável.",
        detail1: "Blockchains L1 lidam apenas com netting final — não cada compra de café. Esta carga de liquidação ultra-baixa significa que até telefones podem verificar toda a chain. Poda de estado mantém armazenamento mínimo: verificação completa, não histórico completo. Sem light clients, sem suposições de confiança.",
        detail2: "Isso implementa a visão original de Satoshi e Vitalik: verificação soberana sem intermediários confiáveis. Suas chaves, seu node, suas regras."
      },
      simple: {
        title: "Simples",
        desc: "<strong>Banking 2.0</strong> sem inventar nova terminologia.",
        detail1: "Crédito, colateral, reservas, transferências. Conceitos que você já conhece. Sem zkSNARKs para entender, sem árvores merkle para auditar. Apenas finanças, mas programáveis.",
        detail2: "Complexidade escondida no protocolo. Simplicidade exposta aos usuários. É assim que a internet escalou — e é assim que as finanças vão escalar."
      }
    },
    roadmap: {
      title: "Roteiro",
      q4_2025: { quarter: "Q4 2025", title: "Design do Protocolo Completo", items: ["Arquitetura de runtime finalizada", "Especificação de consenso bilateral", "Design de contratos inteligentes"] },
      q1_2026: { quarter: "Q1 2026", title: "Lançamento da Testnet", items: ["Deploy na Ethereum Sepolia", "Sandbox para desenvolvedores com entidades demo", "Documentação pública da API"] },
      q2_2026: { quarter: "Q2 2026", title: "Expansão Multi-Chain", items: ["Suporte para Arbitrum, Optimism, Base", "Demos de liquidação cross-chain", "Benchmarks de performance publicados"] },
      q3_2026: { quarter: "Q3 2026", title: "Auditorias de Segurança e Mainnet Beta", items: ["Auditorias de segurança terceirizadas", "Lançamento do programa bug bounty", "Mainnet beta com entidades whitelisted"] },
      q4_2026: { quarter: "Q4 2026", title: "Mainnet Público", items: ["Registro aberto de entidades", "SDKs de produção (TypeScript, Python)", "Ativação do framework de governança"] },
      future: { quarter: "2027+", title: "Camada de Integração CBDC", items: ["Parcerias com bancos centrais", "Substrato programável CBDC", "Protocolo de interoperabilidade universal"] }
    },
    newsletter: {
      title: "Junte-se à Revolução Unicast",
      subtitle: "Receba notificações sobre o lançamento da mainnet, análises técnicas profundas e atualizações do protocolo",
      placeholder: "seu@email.com",
      button: "Inscrever-se",
      note: "Sem spam. Cancele quando quiser."
    },
    cbdc: {
      title: "O Substrato Universal para CBDC",
      intro: "xln não é apenas \"melhores canais de pagamento\" — é a camada de liquidação para dinheiro programável em escala planetária.",
      today: "<strong>Hoje:</strong> Substrato EVM universal — funciona com qualquer chain EVM (Ethereum L1, rollups, alt-L1s: Polygon, Arbitrum, Base, BSC, etc.)",
      tomorrow: "<strong>Amanhã:</strong> O mesmo substrato serve CBDCs — quando bancos centrais lançarem dinheiro programável compatível com EVM, xln se torna a camada de interoperabilidade universal",
      countries: "países",
      pilot: "em fase piloto",
      gdp: "do PIB global",
      building: "construindo livros-razão programáveis",
      vision: "A maioria será compatível com EVM. xln se conecta a <strong>qualquer</strong> livro-razão programável implantando <code>Depository.sol</code>."
    },
    invite: {
      placeholder: "Código de Acesso",
      button: "Desbloquear",
      invalid: "Código inválido"
    }
  },
  de: {
    hero: {
      title: "Ein Protokoll. Jede Jurisdiktion. Jedes programmierbare Hauptbuch.",
      subtitle: "Das universelle CBDC-Substrat für planetarische Abwicklung"
    },
    founder: {
      quote: "Nach 13 Jahren Prüfung von Zahlungssystemen und Blockchains habe ich das Protokoll gebaut, das ich mir immer gewünscht hatte.",
      signature: "Egor Homakov"
    },
    problem: {
      title: "137 Länder bauen programmierbares Geld",
      intro: "CBDCs, Stablecoins, tokenisierte Vermögenswerte—98% des globalen BIP werden programmierbar. Die 100-Billionen-Dollar-Frage ist nicht, <em>ob</em> programmierbare Hauptbücher gewinnen. Es ist <strong>wie sie ohne Verwahrer skalieren</strong>.",
      vision: "Alle bestehenden Antworten scheitern im planetarischen Maßstab:",
      tradfi: "<strong>TradFi/CEX (traditionelle Banken, Binance, Coinbase):</strong> 100T$ Wirtschaft, 10T$ tägliches Volumen, aber Verwahrung — Bankenrettungen, FTX-Zusammenbruch, Mt. Gox",
      bigBlocks: "<strong>Alle Big Blocker (Solana, Tron, BSC):</strong> 80B$+ Marktkapitalisierung, aber können keine Full Nodes betreiben — zentralisiert by Design",
      rollups: "<strong>Alle Rollups (Arbitrum, Optimism, zkSync, StarkNet):</strong> 10B$+ TVL, aber Datenverfügbarkeitsparadoxon — vertraue Drittausschüssen, flüchtigen Calldata oder teurem Blobspace. Das DA/Verifizierer-Dilemma ist mathematisch unlösbar: Sie können nicht gleichzeitig günstige Verifizierung, permanente Daten und keine Vertrauensannahmen haben. Es ist ein Catch-22, kein Tradeoff.",
      sharding: "<strong>Sharding-Chains (NEAR, TON, Zilliqa, MultiversX):</strong> Immer noch O(n) Broadcast innerhalb von Shards — löst den grundlegenden Engpass nicht. Sicherheitsverwässerung bedeutet: ein kompromittierter Shard gefährdet das gesamte Netzwerk.",
      fcuan: "Jahrhundertelang liefen Finanzen auf <strong>Full-Credit Unprovable Account Networks (FCUAN)</strong>: traditionelles Banking, CEXs, Broker. Reiner Kredit skaliert phänomenal, bietet aber schwache Sicherheit—Vermögenswerte können beschlagnahmt werden, Hubs können ausfallen.",
      frpap: "2015 führte Lightning <strong>Full-Reserve Provable Account Primitives (FRPAP)</strong> ein: Zahlungskanäle mit kryptographischen Beweisen. Volle Sicherheit, trifft aber auf die <em>eingehende Liquiditätswand</em>—eine architektonische Grenze, kein Bug. Lightning, Raiden, Connext, Celer — alle Zahlungskanalprojecte sind tot oder haben pivotiert."
    },
    solution: {
      title: "Die Lösung",
      intro: "<strong>xln</strong> ist das erste <strong>Reserve-Credit Provable Account Network (RCPAN)</strong>: Kredit wo es skaliert, Sicherheiten wo es sichert. Ein prinzipieller Hybrid.",
      evolution: "Die Evolution der Abwicklung",
      fcuanDesc: "Banking. Reiner Kredit, 7000 Jahre dominant.",
      frpapDesc: "Lightning. Gescheitert (Liquiditätswand).",
      rcpanDesc: "<strong>xln:</strong> Banking + Lightning = RCPAN. Das logische Ende."
    },
    whyNow: {
      title: "Warum jetzt?",
      items: [
        "<strong>2025:</strong> 72 CBDCs in der Pilotphase",
        "<strong>2026:</strong> Grenzüberschreitende CBDC-Interoperabilität wird politisch zwingend",
        "<strong>Legacy-Schienen inkompatibel:</strong> SWIFT und Korrespondenzbanken können programmierbares Geld nicht handhaben",
        "<strong>Fenster schließt sich:</strong> Jede CBDC, die inkompatible Skalierungslösungen baut, schafft permanente Fragmentierung",
        "<strong>Universelles Substrat JETZT benötigt:</strong> Bevor Standards verknöchern"
      ]
    },
    contracts: {
      title: "Modulares Vertragssystem",
      subtitle: "Das gesamte Finanzsystem als steckbare Lego-Steine. Deploye deine eigenen. Erweitere für immer.",
      note: "<strong>Depository</strong> = unveränderlicher Vertrauensanker. <strong>Module</strong> = austauschbare Implementierungen. Deploye <code>YourCustomEntityProvider.sol</code> jederzeit."
    },
    properties: {
      title: "Schlüsseleigenschaften",
      items: [
        "Unendliche Skalierbarkeit: O(1) Updates pro Hop vs O(n) Broadcast",
        "Kein Problem mit eingehender Liquidität: Kredit + Sicherheiten Hybrid",
        "Begrenztes Risiko: Gegenpartei-Verlust begrenzt auf Sicherheiten + Kredit",
        "Starke Privatsphäre: Zwiebel-Routing (Zahlungssender/-empfänger anonym für Routing-Hubs, wie Tor für Geld)",
        "<strong>Lokaler Zustand: keine Sequencer, keine Datenverfügbarkeitsabhängigkeiten</strong>"
      ]
    },
    tripleS: {
      title: "Triple-S Grundprinzipien",
      scalable: {
        title: "Skalierbar",
        desc: "<strong>Unicast (1-zu-1)</strong> Architektur ermöglicht unbegrenzte horizontale Skalierung. Keine Broadcast-Engpässe, keine globalen Konsensverzögerungen.",
        detail1: "O(1) Updates pro Hop vs O(n) Broadcast-Overhead. Gegenparteien wählen optimale Routing-Pfade durch Coasianische Verhandlung — von CBDCs bis Kaffee, vom Dorf zum Globus.",
        detail2: "Es gibt einfach keinen anderen Weg, auf den gesamten Planeten zu skalieren. Das Internet hat bereits bewiesen, dass Unicast im globalen Maßstab gewinnt."
      },
      secure: {
        title: "Sicher",
        desc: "<strong>Jedes Telefon und Laptop wird standardmäßig eine Full Node sein.</strong> Nicht verhandelbar.",
        detail1: "L1-Blockchains handhaben nur das finale Netting — nicht jeden Kaffeekauf. Diese ultra-niedrige Abwicklungslast bedeutet, dass sogar Telefone die gesamte Kette verifizieren können. State Pruning hält den Speicher minimal: vollständige Verifizierung, nicht vollständige Historie. Keine Light Clients, keine Vertrauensannahmen.",
        detail2: "Dies implementiert die ursprüngliche Vision von Satoshi und Vitalik: souveräne Verifizierung ohne vertrauenswürdige Intermediäre. Deine Schlüssel, deine Node, deine Regeln."
      },
      simple: {
        title: "Einfach",
        desc: "<strong>Banking 2.0</strong> ohne neue Terminologie zu erfinden.",
        detail1: "Kredit, Sicherheiten, Reserven, Überweisungen. Konzepte, die du bereits kennst. Keine zkSNARKs zu verstehen, keine Merkle-Bäume zu prüfen. Einfach Finanzen, aber programmierbar.",
        detail2: "Komplexität im Protokoll versteckt. Einfachheit den Nutzern präsentiert. So hat das Internet skaliert — und so werden Finanzen skalieren."
      }
    },
    roadmap: {
      title: "Roadmap",
      q4_2025: { quarter: "Q4 2025", title: "Protokoll-Design abgeschlossen", items: ["Runtime-Architektur finalisiert", "Bilaterale Konsens-Spezifikation", "Smart Contract Design"] },
      q1_2026: { quarter: "Q1 2026", title: "Testnet-Start", items: ["Deploy auf Ethereum Sepolia", "Entwickler-Sandbox mit Demo-Entitäten", "Öffentliche API-Dokumentation"] },
      q2_2026: { quarter: "Q2 2026", title: "Multi-Chain Erweiterung", items: ["Arbitrum, Optimism, Base Support", "Cross-Chain Abwicklungs-Demos", "Performance-Benchmarks veröffentlicht"] },
      q3_2026: { quarter: "Q3 2026", title: "Sicherheitsaudits & Mainnet Beta", items: ["Externe Sicherheitsaudits", "Bug-Bounty-Programm gestartet", "Mainnet Beta mit gewhitelisteten Entitäten"] },
      q4_2026: { quarter: "Q4 2026", title: "Öffentliches Mainnet", items: ["Offene Entitätsregistrierung", "Produktionsreife SDKs (TypeScript, Python)", "Governance-Framework aktiviert"] },
      future: { quarter: "2027+", title: "CBDC-Integrationsschicht", items: ["Partnerschaften mit Zentralbanken", "Programmierbares CBDC-Substrat", "Universelles Interop-Protokoll"] }
    },
    newsletter: {
      title: "Tritt der Unicast-Revolution bei",
      subtitle: "Werde über Mainnet-Start, technische Deep-Dives und Protokoll-Updates informiert",
      placeholder: "deine@email.com",
      button: "Abonnieren",
      note: "Kein Spam. Jederzeit abmelden."
    },
    cbdc: {
      title: "Das universelle CBDC-Substrat",
      intro: "xln ist nicht nur \"bessere Zahlungskanäle\" — es ist die Abwicklungsschicht für programmierbares Geld im planetarischen Maßstab.",
      today: "<strong>Heute:</strong> Universelles EVM-Substrat — funktioniert mit jeder EVM-Chain (Ethereum L1, Rollups, Alt-L1s: Polygon, Arbitrum, Base, BSC, etc.)",
      tomorrow: "<strong>Morgen:</strong> Dasselbe Substrat bedient CBDCs — wenn Zentralbanken EVM-kompatibles programmierbares Geld starten, wird xln zur universellen Interop-Schicht",
      countries: "Länder",
      pilot: "in der Pilotphase",
      gdp: "des globalen BIP",
      building: "bauen programmierbare Hauptbücher",
      vision: "Die meisten werden EVM-kompatibel sein. xln verbindet sich mit <strong>jedem</strong> programmierbaren Hauptbuch durch Deployment von <code>Depository.sol</code>."
    },
    invite: {
      placeholder: "Zugangscode",
      button: "Entsperren",
      invalid: "Ungültiger Code"
    }
  },
  fr: {
    hero: {
      title: "Un protocole. Chaque juridiction. Chaque registre programmable.",
      subtitle: "Le substrat universel CBDC pour le règlement à l'échelle planétaire"
    },
    founder: {
      quote: "Après 13 ans d'audit des systèmes de paiement et des blockchains, j'ai construit le protocole que j'ai toujours souhaité voir exister.",
      signature: "Egor Homakov"
    },
    problem: {
      title: "137 pays construisent de l'argent programmable",
      intro: "CBDCs, stablecoins, actifs tokenisés—98% du PIB mondial devient programmable. La question à 100 billions de dollars n'est pas <em>si</em> les registres programmables gagnent. C'est <strong>comment ils évoluent sans dépositaires</strong>.",
      vision: "Toutes les réponses existantes échouent à l'échelle planétaire :",
      tradfi: "<strong>TradFi/CEX (banques traditionnelles, Binance, Coinbase) :</strong> économie de 100T$, volume quotidien de 10T$, mais custodial — renflouements bancaires, effondrement FTX, Mt. Gox",
      bigBlocks: "<strong>Tous les big blockers (Solana, Tron, BSC) :</strong> capitalisation de +80B$, mais ne peuvent pas exécuter de nœuds complets — centralisés par conception",
      rollups: "<strong>Tous les rollups (Arbitrum, Optimism, zkSync, StarkNet) :</strong> TVL +10B$, mais paradoxe de disponibilité des données — faire confiance aux comités tiers, aux calldata éphémères ou au blobspace coûteux. Le dilemme DA/vérificateur est mathématiquement insoluble : vous ne pouvez pas avoir simultanément une vérification bon marché, des données permanentes et aucune hypothèse de confiance. C'est un catch-22, pas un compromis.",
      sharding: "<strong>Chaînes de sharding (NEAR, TON, Zilliqa, MultiversX) :</strong> Toujours broadcast O(n) au sein des shards — ne résout pas le goulot d'étranglement fondamental. La dilution de sécurité signifie qu'un shard compromis met tout le réseau en danger.",
      fcuan: "Pendant des siècles, la finance a fonctionné sur des <strong>Réseaux de Comptes à Crédit Total Non Prouvables (FCUAN)</strong> : banques traditionnelles, CEXs, courtiers. Le crédit pur évolue phénoménalement mais offre une sécurité faible—les actifs peuvent être saisis, les hubs peuvent faire défaut.",
      frpap: "En 2015, Lightning a introduit les <strong>Primitives de Comptes Prouvables à Réserve Totale (FRPAP)</strong> : canaux de paiement avec preuves cryptographiques. Sécurité totale mais heurte le <em>mur de liquidité entrante</em>—une limite architecturale, pas un bug. Lightning, Raiden, Connext, Celer — tous les projets de canaux de paiement sont morts ou ont pivoté."
    },
    solution: {
      title: "La Solution",
      intro: "<strong>xln</strong> est le premier <strong>Réseau de Comptes Prouvables Réserve-Crédit (RCPAN)</strong> : crédit là où ça évolue, collatéral là où ça sécurise. Un hybride de principe.",
      evolution: "L'Évolution du Règlement",
      fcuanDesc: "Banque. Crédit pur, 7000 ans de domination.",
      frpapDesc: "Lightning. Échec (mur de liquidité).",
      rcpanDesc: "<strong>xln :</strong> Banque + Lightning = RCPAN. La fin logique."
    },
    whyNow: {
      title: "Pourquoi maintenant ?",
      items: [
        "<strong>2025 :</strong> 72 CBDCs en phase pilote",
        "<strong>2026 :</strong> L'interopérabilité transfrontalière des CBDC devient un impératif politique",
        "<strong>Rails legacy incompatibles :</strong> SWIFT et les banques correspondantes ne peuvent pas gérer l'argent programmable",
        "<strong>La fenêtre se ferme :</strong> Chaque CBDC construisant des solutions d'évolution incompatibles crée une fragmentation permanente",
        "<strong>Substrat universel nécessaire MAINTENANT :</strong> Avant que les standards ne s'ossifient"
      ]
    },
    contracts: {
      title: "Système de Contrats Modulaire",
      subtitle: "L'ensemble du système financier comme des briques Lego enfichables. Déployez les vôtres. Étendez à l'infini.",
      note: "<strong>Depository</strong> = ancre de confiance immuable. <strong>Modules</strong> = implémentations remplaçables à chaud. Déployez <code>YourCustomEntityProvider.sol</code> à tout moment."
    },
    properties: {
      title: "Propriétés Clés",
      items: [
        "Évolutivité infinie : mises à jour O(1) par saut vs broadcast O(n)",
        "Pas de problème de liquidité entrante : hybride crédit + collatéral",
        "Risque limité : perte de contrepartie plafonnée au collatéral + crédit",
        "Confidentialité forte : routage en oignon (expéditeur/destinataire anonymes pour les hubs de routage, comme Tor pour l'argent)",
        "<strong>État local : pas de séquenceurs, pas de dépendances de disponibilité des données</strong>"
      ]
    },
    tripleS: {
      title: "Principes Fondamentaux Triple-S",
      scalable: {
        title: "Évolutif",
        desc: "L'architecture <strong>Unicast (1-à-1)</strong> permet une mise à l'échelle horizontale illimitée. Pas de goulots d'étranglement de broadcast, pas de retards de consensus global.",
        detail1: "Mises à jour O(1) par saut vs overhead de broadcast O(n). Les contreparties auto-sélectionnent les chemins de routage optimaux par négociation Coasienne — des CBDCs au café, du village au globe.",
        detail2: "Il n'y a simplement pas d'autre moyen d'évoluer à l'échelle de la planète entière. Internet a déjà prouvé que l'unicast gagne à l'échelle mondiale."
      },
      secure: {
        title: "Sécurisé",
        desc: "<strong>Chaque téléphone et ordinateur portable sera un nœud complet par défaut.</strong> Non négociable.",
        detail1: "Les blockchains L1 ne gèrent que le netting final — pas chaque achat de café. Cette charge de règlement ultra-faible signifie que même les téléphones peuvent vérifier toute la chaîne. L'élagage d'état maintient le stockage minimal : vérification complète, pas d'historique complet. Pas de clients légers, pas d'hypothèses de confiance.",
        detail2: "Cela implémente la vision originale de Satoshi et Vitalik : vérification souveraine sans intermédiaires de confiance. Vos clés, votre nœud, vos règles."
      },
      simple: {
        title: "Simple",
        desc: "<strong>Banque 2.0</strong> sans inventer de nouvelle terminologie.",
        detail1: "Crédit, collatéral, réserves, transferts. Des concepts que vous connaissez déjà. Pas de zkSNARKs à comprendre, pas d'arbres merkle à auditer. Juste de la finance, mais programmable.",
        detail2: "La complexité cachée dans le protocole. La simplicité exposée aux utilisateurs. C'est ainsi qu'Internet a évolué — et c'est ainsi que la finance évoluera."
      }
    },
    roadmap: {
      title: "Feuille de Route",
      q4_2025: { quarter: "Q4 2025", title: "Conception du Protocole Terminée", items: ["Architecture runtime finalisée", "Spécification de consensus bilatéral", "Conception des smart contracts"] },
      q1_2026: { quarter: "Q1 2026", title: "Lancement du Testnet", items: ["Déploiement sur Ethereum Sepolia", "Bac à sable développeur avec entités démo", "Documentation API publique"] },
      q2_2026: { quarter: "Q2 2026", title: "Expansion Multi-Chaîne", items: ["Support Arbitrum, Optimism, Base", "Démos de règlement cross-chain", "Benchmarks de performance publiés"] },
      q3_2026: { quarter: "Q3 2026", title: "Audits de Sécurité et Mainnet Beta", items: ["Audits de sécurité tiers", "Lancement du programme bug bounty", "Mainnet beta avec entités whitelistées"] },
      q4_2026: { quarter: "Q4 2026", title: "Mainnet Public", items: ["Enregistrement ouvert des entités", "SDKs de production (TypeScript, Python)", "Activation du framework de gouvernance"] },
      future: { quarter: "2027+", title: "Couche d'Intégration CBDC", items: ["Partenariats avec les banques centrales", "Substrat CBDC programmable", "Protocole d'interopérabilité universel"] }
    },
    newsletter: {
      title: "Rejoignez la Révolution Unicast",
      subtitle: "Soyez notifié du lancement mainnet, des analyses techniques approfondies et des mises à jour du protocole",
      placeholder: "votre@email.com",
      button: "S'abonner",
      note: "Pas de spam. Désabonnement à tout moment."
    },
    cbdc: {
      title: "Le Substrat Universel CBDC",
      intro: "xln n'est pas juste de \"meilleurs canaux de paiement\" — c'est la couche de règlement pour l'argent programmable à l'échelle planétaire.",
      today: "<strong>Aujourd'hui :</strong> Substrat EVM universel — fonctionne avec n'importe quelle chaîne EVM (Ethereum L1, rollups, alt-L1s : Polygon, Arbitrum, Base, BSC, etc.)",
      tomorrow: "<strong>Demain :</strong> Le même substrat sert les CBDCs — quand les banques centrales lanceront de l'argent programmable compatible EVM, xln deviendra la couche d'interopérabilité universelle",
      countries: "pays",
      pilot: "en phase pilote",
      gdp: "du PIB mondial",
      building: "construisant des registres programmables",
      vision: "La plupart seront compatibles EVM. xln se connecte à <strong>n'importe quel</strong> registre programmable en déployant <code>Depository.sol</code>."
    },
    invite: {
      placeholder: "Code d'Accès",
      button: "Déverrouiller",
      invalid: "Code invalide"
    }
  },
  tr: {
    hero: {
      title: "Tek protokol. Her yetki alanı. Her programlanabilir defter.",
      subtitle: "Gezegen ölçekli uzlaşma için evrensel CBDC altyapısı"
    },
    founder: {
      quote: "13 yıl boyunca ödeme sistemlerini ve blok zincirlerini denetledikten sonra, her zaman var olmasını dilediğim protokolü inşa ettim.",
      signature: "Egor Homakov"
    },
    problem: {
      title: "137 ülke programlanabilir para inşa ediyor",
      intro: "CBDC'ler, stablecoin'ler, tokenize varlıklar—küresel GSYİH'nin %98'i programlanabilir hale geliyor. 100 trilyon dolarlık soru, programlanabilir defterlerin <em>kazanıp kazanmayacağı</em> değil. <strong>Saklayıcılar olmadan nasıl ölçeklenecekleri</strong>.",
      vision: "Mevcut tüm cevaplar gezegen ölçeğinde başarısız oluyor:",
      tradfi: "<strong>TradFi/CEX (geleneksel bankalar, Binance, Coinbase):</strong> 100T$ ekonomi, 10T$ günlük hacim, ama saklama modeli — banka kurtarmaları, FTX çöküşü, Mt. Gox",
      bigBlocks: "<strong>Tüm big blocker'lar (Solana, Tron, BSC):</strong> 80B$+ piyasa değeri, ama tam düğüm çalıştıramıyor — tasarımı gereği merkezi",
      rollups: "<strong>Tüm rollup'lar (Arbitrum, Optimism, zkSync, StarkNet):</strong> 10B$+ TVL, ama veri kullanılabilirliği paradoksu — üçüncü taraf komitelere, geçici calldata'ya veya pahalı blobspace'e güven. DA/doğrulayıcı ikilemi matematiksel olarak çözülemez: aynı anda ucuz doğrulama, kalıcı veri ve sıfır güven varsayımına sahip olamazsınız. Bu bir catch-22, değiş tokuş değil.",
      sharding: "<strong>Sharding zincirleri (NEAR, TON, Zilliqa, MultiversX):</strong> Shard'lar içinde hala O(n) yayın — temel darboğazı çözmüyor. Güvenlik seyreltmesi, bir shard tehlikeye girdiğinde tüm ağın risk altında olduğu anlamına gelir.",
      fcuan: "Yüzyıllar boyunca finans, <strong>Tam Kredi Kanıtlanamaz Hesap Ağları (FCUAN)</strong> üzerinde çalıştı: geleneksel bankacılık, CEX'ler, brokerlar. Saf kredi olağanüstü ölçeklenir ama zayıf güvenlik sunar—varlıklar el konulabilir, hub'lar temerrüde düşebilir.",
      frpap: "2015'te Lightning, <strong>Tam Rezerv Kanıtlanabilir Hesap İlkelleri (FRPAP)</strong>'ni tanıttı: kriptografik kanıtlı ödeme kanalları. Tam güvenlik ama <em>gelen likidite duvarına</em> çarpıyor—bu bir bug değil, mimari sınır. Lightning, Raiden, Connext, Celer — tüm ödeme kanalı projeleri öldü veya pivot yaptı."
    },
    solution: {
      title: "Çözüm",
      intro: "<strong>xln</strong> ilk <strong>Rezerv-Kredi Kanıtlanabilir Hesap Ağı (RCPAN)</strong>'dır: ölçeklendiği yerde kredi, güvence altına aldığı yerde teminat. İlkeli bir hibrit.",
      evolution: "Uzlaşmanın Evrimi",
      fcuanDesc: "Bankacılık. Saf kredi, 7000 yıl baskın.",
      frpapDesc: "Lightning. Başarısız (likidite duvarı).",
      rcpanDesc: "<strong>xln:</strong> Bankacılık + Lightning = RCPAN. Mantıksal son."
    },
    whyNow: {
      title: "Neden şimdi?",
      items: [
        "<strong>2025:</strong> 72 CBDC pilot aşamasında",
        "<strong>2026:</strong> Sınır ötesi CBDC birlikte çalışabilirliği politik zorunluluk oluyor",
        "<strong>Eski raylar uyumsuz:</strong> SWIFT ve muhabir bankacılık programlanabilir parayı kaldıramaz",
        "<strong>Pencere kapanıyor:</strong> Uyumsuz ölçekleme çözümleri inşa eden her CBDC kalıcı parçalanma yaratır",
        "<strong>Evrensel altyapı ŞİMDİ gerekli:</strong> Standartlar kemikleşmeden önce"
      ]
    },
    contracts: {
      title: "Modüler Sözleşme Sistemi",
      subtitle: "Tüm finansal sistem takılabilir Lego tuğlaları olarak. Kendinizinkini dağıtın. Sonsuza kadar genişletin.",
      note: "<strong>Depository</strong> = değişmez güven çapası. <strong>Modüller</strong> = sıcak değiştirilebilir uygulamalar. <code>YourCustomEntityProvider.sol</code>'u istediğiniz zaman dağıtın."
    },
    properties: {
      title: "Temel Özellikler",
      items: [
        "Sonsuz ölçeklenebilirlik: atlama başına O(1) güncellemeler vs O(n) yayın",
        "Gelen likidite sorunu yok: kredi + teminat hibriti",
        "Sınırlı risk: karşı taraf kaybı teminat + kredi ile sınırlı",
        "Güçlü gizlilik: soğan yönlendirme (ödeme gönderen/alıcı yönlendirme hub'larına anonim, para için Tor gibi)",
        "<strong>Yerel durum: sıralayıcı yok, veri kullanılabilirliği bağımlılığı yok</strong>"
      ]
    },
    tripleS: {
      title: "Triple-S Temel İlkeler",
      scalable: {
        title: "Ölçeklenebilir",
        desc: "<strong>Unicast (1'e-1)</strong> mimarisi sınırsız yatay ölçekleme sağlar. Yayın darboğazı yok, küresel konsensüs gecikmesi yok.",
        detail1: "Atlama başına O(1) güncellemeler vs O(n) yayın yükü. Karşı taraflar Coasian müzakere yoluyla optimal yönlendirme yollarını kendi seçer — CBDC'lerden kahveye, köyden küreye.",
        detail2: "Tüm gezegene ölçeklemenin başka yolu yok. İnternet zaten unicast'in küresel ölçekte kazandığını kanıtladı."
      },
      secure: {
        title: "Güvenli",
        desc: "<strong>Her telefon ve dizüstü bilgisayar varsayılan olarak tam düğüm olacak.</strong> Pazarlık edilemez.",
        detail1: "L1 blok zincirleri yalnızca nihai netleştirmeyi işler — her kahve satın alımını değil. Bu ultra düşük uzlaşma yükü, telefonların bile tüm zinciri doğrulayabileceği anlamına gelir. Durum budaması depolamayı minimum tutar: tam doğrulama, tam geçmiş değil. Hafif istemci yok, güven varsayımı yok.",
        detail2: "Bu, Satoshi ve Vitalik'in orijinal vizyonunu uygular: güvenilir aracılar olmadan egemen doğrulama. Anahtarların senin, düğümün senin, kuralların senin."
      },
      simple: {
        title: "Basit",
        desc: "<strong>Bankacılık 2.0</strong>, sıfır yeni terminoloji icat edilmiş.",
        detail1: "Kredi, teminat, rezervler, transferler. Zaten bildiğiniz kavramlar. Anlaşılacak zkSNARK yok, denetlenecek merkle ağacı yok. Sadece finans, ama programlanabilir.",
        detail2: "Karmaşıklık protokolde gizli. Sadelik kullanıcılara sunuluyor. İnternet böyle ölçeklendi — ve finans böyle ölçeklenecek."
      }
    },
    roadmap: {
      title: "Yol Haritası",
      q4_2025: { quarter: "Q4 2025", title: "Protokol Tasarımı Tamamlandı", items: ["Runtime mimarisi tamamlandı", "İkili konsensüs spesifikasyonu", "Akıllı sözleşme tasarımı"] },
      q1_2026: { quarter: "Q1 2026", title: "Testnet Başlatma", items: ["Ethereum Sepolia'ya dağıtım", "Demo varlıklarla geliştirici sandbox'ı", "Halka açık API dokümantasyonu"] },
      q2_2026: { quarter: "Q2 2026", title: "Çok Zincirli Genişleme", items: ["Arbitrum, Optimism, Base desteği", "Zincirler arası uzlaşma demoları", "Performans benchmark'ları yayınlandı"] },
      q3_2026: { quarter: "Q3 2026", title: "Güvenlik Denetimleri ve Mainnet Beta", items: ["Üçüncü taraf güvenlik denetimleri", "Bug bounty programı başlatıldı", "Beyaz listeye alınmış varlıklarla mainnet beta"] },
      q4_2026: { quarter: "Q4 2026", title: "Halka Açık Mainnet", items: ["Açık varlık kaydı", "Üretim kalitesinde SDK'lar (TypeScript, Python)", "Yönetişim çerçevesi aktifleştirildi"] },
      future: { quarter: "2027+", title: "CBDC Entegrasyon Katmanı", items: ["Merkez bankalarıyla ortaklıklar", "Programlanabilir CBDC altyapısı", "Evrensel birlikte çalışabilirlik protokolü"] }
    },
    newsletter: {
      title: "Unicast Devrimine Katılın",
      subtitle: "Mainnet lansmanı, teknik derin dalışlar ve protokol güncellemeleri hakkında bildirim alın",
      placeholder: "sizin@email.com",
      button: "Abone Ol",
      note: "Spam yok. İstediğiniz zaman abonelikten çıkın."
    },
    cbdc: {
      title: "Evrensel CBDC Altyapısı",
      intro: "xln sadece \"daha iyi ödeme kanalları\" değil — gezegen ölçeğinde programlanabilir para için uzlaşma katmanı.",
      today: "<strong>Bugün:</strong> Evrensel EVM altyapısı — herhangi bir EVM zinciri ile çalışır (Ethereum L1, rollup'lar, alt-L1'ler: Polygon, Arbitrum, Base, BSC, vb.)",
      tomorrow: "<strong>Yarın:</strong> Aynı altyapı CBDC'lere hizmet eder — merkez bankaları EVM uyumlu programlanabilir para başlattığında, xln evrensel birlikte çalışabilirlik katmanı olur",
      countries: "ülke",
      pilot: "pilot aşamasında",
      gdp: "küresel GSYİH'nin",
      building: "programlanabilir defterler inşa ediyor",
      vision: "Çoğu EVM uyumlu olacak. xln <code>Depository.sol</code> dağıtarak <strong>herhangi bir</strong> programlanabilir deftere bağlanır."
    },
    invite: {
      placeholder: "Erişim Kodu",
      button: "Kilidi Aç",
      invalid: "Geçersiz kod"
    }
  }
} as const;

export type ContentLang = keyof typeof content;
export type Content = typeof content.en;
