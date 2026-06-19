# XLN / RCPAN v3: proof layer for commercial credit

**Дата:** 2026-06-17  
**Назначение:** hardened brief для LLM, банков, регуляторов, центральных банков, платежных компаний, институциональных крипто-контрагентов и государств.  
**Термин:** система называется **XLN**, не XLM. XLM уже ассоциируется со Stellar.  
**Главная правка v3:** XLN/RCPAN как идея важнее, чем XLN как текущая реализация. Доктрина сильная; production-readiness должна оставаться консервативной.

> **Best one-liner:** XLN is not a blockchain for payments; it is a proof layer for commercial credit, with blockchain used only when trust fails.

> **Russian compression:** XLN - это не блокчейн-касса. Это доказуемый слой коммерческого кредита, где цепь работает как суд, залоговый якорь и механизм исполнения при отказе доверия.

---

## 0. The doctrine in one page

Old banks solved scale with credit but kept the credit state weakly provable. Old crypto solved proof but often removed credit and forced too much activity into global public consensus.

**The corrected doctrine:**

```text
Old banks: credit without proofs.
Old crypto: proofs without credit.
XLN/RCPAN: credit with proofs.
```

The category correction is the whole product:

```text
Blockchain should be the court, not the cash register.
```

A country, bank or AI-agent economy does not need every invoice, internal transfer, liquidity adjustment and bilateral netting event to be public-chain state. It needs signed bilateral obligations, measurable limits, enforceable collateral and a credible dispute venue.

**XLN/RCPAN as a doctrine:** a verifiable bilateral account layer for regulated and semi-regulated institutions.

**XLN as current implementation:** a public-testnet / pre-mainnet engineering system that must still prove recovery, evidence availability, dispute finalization, audits, operations and pilot outcomes before being sold as real-user-fund infrastructure.

This separation makes the pitch stronger, not weaker.

---

## 1. The invariant: why the idea is clean

```text
-L_left <= Delta <= C + L_right

Delta   = signed bilateral net balance
C       = collateral anchored in a programmable settlement/enforcement venue
L_left  = credit limit one side extends in one direction
L_right = credit limit the other side extends in the other direction
```

This is not just a formula. It is a two-axis design space:

| Corner | Parameter choice | What it recovers | Strength | Weakness |
|---|---:|---|---|---|
| Banks / FCUAN | `C = 0` | credit ledgers, bilateral accounts, commercial banking | scale, elasticity, relationship credit | proof gaps, reconciliation, runs, opaque exposure |
| Lightning / FRPAP | `L_left = L_right = 0` | full-reserve channels | strong collateral proof, no credit exposure | inbound liquidity wall, high capital lockup |
| RCPAN / XLN | `C` and `L` both configurable | hybrid credit + collateral + proofs | risk-weighted capital efficiency and enforceability | larger attack surface, audit cost, credit-risk governance |

**Important nuance:** “superset” means the mechanism can represent the corners. It does **not** mean automatic practical dominance. Dominance must be earned by audit, UX, liquidity, regulatory mapping, operational reliability and pilot data.

---

## 2. Correct finality language

Do not oversell “instant finality.” A competent legal or central-bank reader will object immediately.

| Bad phrase | Why it is weak | Correct phrase |
|---|---|---|
| “Instant finality.” | Legal finality depends on jurisdiction, dispute rules, insolvency law and admissibility of evidence. | “Instant bilateral commitment” or “instant bilateral settlement subject to dispute rules.” |
| “No fraud period.” | There may be dispute windows and recovery windows even if the normal fast path has mutual signatures. | “No normal-path global fraud period; the rare path uses jurisdiction-specific dispute rules.” |
| “On-chain dispute always fixes worst case.” | Only true if the user can construct valid evidence and the salvage -> evidence -> dispute -> finalization path works. | “The on-chain backstop is only as good as recovery, evidence availability and tested dispute finalization.” |

**Clean sentence:** In XLN, the fast path gives immediate mutual commitment between counterparties; enforceable legal/economic finality depends on the configured jurisdiction, dispute window, evidence availability and insolvency/resolution framework.

---

## 3. The real launch risk: recovery and evidence availability

The invariant is elegant. The hard real-world failure mode is not the math. It is operational and evidentiary:

```text
browser wiped
counterparty offline
hub disappears
stale state appears
transformer evidence missing
user cannot build dispute packet
watchtower does not have latest bundle
salvage path cannot reach finalization
```

A system that says “just go on-chain” but cannot reliably produce the exact proof packet is not safe enough for real funds.

### 3.1 Recovery/evidence checklist

| Required capability | Why it matters | Conservative claim |
|---|---|---|
| Peer State Refresh | A wiped client must recover latest signed state from honest peers/hubs. | Open / launch-gate unless fully implemented and tested. |
| Watchtower backup | Offline users need encrypted last-known state and delayed counter-dispute support. | Necessary for consumer-grade safety. |
| Evidence snapshots | Transformer arguments must match the signed proof body, not live mutable state. | Missing evidence must fail closed. |
| Dispute drill | The system must deliberately break off-chain cooperation and still finalize correctly. | “On-chain court works” only after this passes end-to-end. |
| Restore drill | Wiped-browser / restart / lost-local-db scenarios must restore usable state. | Key recovery alone is not account-state recovery. |
| Ops monitoring | Towers, relays, runtime storage, RPC and gas funding must be observable. | Operational failure is protocol failure for users. |

**Hostile-reader-proof line:** XLN’s security argument does not end at the invariant. It ends only when the current implementation can repeatedly demonstrate salvage -> evidence -> dispute -> finalization under adversarial and recovery conditions.

---

## 4. Link-capped is not system-safe

The previous “localized failures” claim must be replaced.

At the edge level, XLN can bound a counterparty’s loss by the credit limit and collateral configuration:

```text
loss(edge A->H) is bounded by the limit A chose plus unsettled operational exposure
```

At the topology level, a hub is a shared counterparty. If one hub fails, every spoke that extended credit to it may realize its capped loss at the same time:

```text
total hub-failure loss <= sum of all spoke credit limits to that hub
```

That sum can be systemic. Capped x correlated is still a cascade.

**Correct central-bank line:** XLN does not eliminate systemic risk; it turns hidden balance-sheet exposure into explicit, signed, measurable bilateral exposure. It gives regulators and counterparties a better risk graph.

### 4.1 Required systemic-risk overlay

| Risk | Why protocol alone is insufficient | Required overlay |
|---|---|---|
| Hub concentration | Many capped links can fail together. | exposure limits, concentration dashboards, stress tests |
| Voluntary limit race | Competition can push credit limits beyond prudence. | capital rules, margin schedules, dynamic limit throttles |
| Rehypothecation | Same collateral can be economically reused if policy permits it. | segregated collateral by default; explicit rehypothecation flags |
| Common asset shock | Many hubs may rely on the same stablecoin/collateral asset. | asset haircuts, reserve attestations, concentration limits |
| Liquidity stress | Solvent but illiquid hubs can still trigger runs. | liquidity buffers, settlement queues, circuit breakers |
| Retail/systemic protection | Edge proofs do not decide social policy. | resolution waterfall, insurance/default fund, supervisory intervention |

**Selling point:** not “no bailouts.” Better: “better resolution telemetry before a bailout is even considered.”

---

## 5. Political translation: replace “EVM jurisdiction” by audience

“EVM jurisdiction” is technically useful, but politically risky. It can sound like “a smart contract replaces the legal system.” Translate it.

| Audience | Use this phrase | Avoid this phrase |
|---|---|---|
| Developers | EVM jurisdiction / programmable settlement court | magic court |
| Banks | programmable collateral and dispute venue | crypto court |
| Regulators | regulated settlement/enforcement layer | lawless smart contract |
| Central banks | programmable wholesale enforcement venue | private money chain |
| Presidents / ministers | digital commercial court for payment obligations | blockchain for every payment |
| Institutional crypto | auditable bilateral settlement backstop | DeFi casino |

**Policy-safe phrase:** XLN uses programmable settlement venues to enforce signed commercial obligations. Legal recognition, admissibility, supervision and insolvency treatment remain jurisdictional policy questions.

---

## 6. The bank wedge: lead here, not with crypto

The strongest pitch is not token, L1, DeFi, rollup or “replace SWIFT.”

Lead with:

> **XLN is a verifiable bilateral account layer for regulated institutions.**

### 6.1 What banks hear

| Bank problem | XLN/RCPAN framing |
|---|---|
| Reconciliation cost | Signed bilateral frames reduce ambiguity between counterparties. |
| Intraday liquidity | Partial collateral + credit limits can reduce idle capital where trust/regulation exists. |
| Counterparty disputes | Dispute packets and deterministic replay make obligations easier to prove. |
| Corporate governance | Entity/quorum signatures map better to organizations than single-key wallets. |
| Compliance | Selective supervisory disclosure can coexist with non-public fast-path commerce. |
| Product expansion | Banks can sell provable credit lines, programmable escrow, trade settlement and AI-agent accounts. |

**Bank-safe tagline:** make commercial-bank credit machine-verifiable without moving every banking transaction to a public chain.

---

## 7. GDP claim becomes a pilot scorecard

Do not say “XLN increases GDP.” Say: XLN targets infrastructure variables that can increase economic activity; a pilot should measure them.

### 7.1 Pilot KPI scorecard

| KPI | Baseline to compare | Why it matters |
|---|---|---|
| Average payment cost | current PSP/bank/correspondent corridor cost | direct reduction in transaction friction |
| Cross-border settlement time | correspondent banking / stablecoin / internal treasury flow | working capital velocity |
| Collateral locked per EUR of throughput | full-reserve channels or exchange pre-funding | capital efficiency |
| Failed payment rate | payment rejections, route failures, stale quotes | reliability and support load |
| Dispute rate | number and value of disputes per volume | operational quality and legal readiness |
| Recovery success rate | wiped-browser / lost-runtime / offline-user drills | real safety, not demo safety |
| Reconciliation hours saved | operations team hours per period | bank/treasury ROI |
| SME cash-conversion-cycle change | invoice-to-usable-funds time | GDP channel through working capital |
| Credit loss per volume settled | losses / total settled value | risk-adjusted performance |
| Liquidity required per EUR of payment flow | prefunding, reserves, collateral | lower capital drag |
| Supervisory exposure completeness | % of exposure graph covered by signed reports | systemic-risk visibility |

**Credible GDP sentence:** If a pilot reduces payment cost, settlement time, reconciliation labor and idle collateral while keeping recovery/dispute success high, then XLN improves infrastructure variables that can support higher economic activity.

---

## 8. AI agents: collateral first, credit later

Do not say XLN gives provable credit to strangers. It does not. Creditworthiness is not an on-chain fact.

| Relationship | Correct default | Reason |
|---|---|---|
| Unknown agent to unknown agent | `L≈0`, collateral-heavy | no reputation, no legal trust, no history |
| Agent to known merchant/API | small risk-based `L` | repeated interaction and limited exposure |
| Agent to regulated hub/bank | larger `L`, capital-backed | supervision, legal recourse, disclosure |
| Agent inside a corporate entity | policy-defined `L/C` | employer/governance controls |

What XLN gives AI agents is still important:

- machine-readable credit limits;
- signed balances;
- collateral status;
- deterministic replay;
- dispute packet construction;
- receipts that agents can verify without trusting dashboards.

**Precise line:** XLN does not prove that a stranger is creditworthy. It makes any credit that is granted explicit, bounded, signed, replayable and enforceable.

---

## 9. Near-term GTM: the boring path that wins

The civilizational doctrine is useful for alignment. The first counterparty buys a narrow risk-reduction workflow.

**Recommended first wedge:** institutional crypto / market-maker / exchange-adjacent pair, audit-first, one bilateral pair, one or two assets, public testnet, collateral-heavy, forced dispute drills.

| Phase | Scope | Success condition |
|---|---|---|
| 1. One bilateral pair | two known entities, one asset | signed frames, replay, no silent divergence |
| 2. Collateral-heavy | low `L`, high `C` | stranger-credit criticism neutralized |
| 3. Forced dispute | intentionally break cooperation | salvage -> evidence -> dispute -> finalization works |
| 4. Recovery drill | wipe browser/runtime state | account state restores and payments resume |
| 5. Exposure report | signed risk snapshot | limits, utilization, collateral and pending settlements visible |
| 6. External audit | contracts + runtime + ops | no real-user funds without independent review |
| 7. Pilot KPI report | compare baseline vs pilot | cost, time, collateral, recovery and reconciliation metrics improve |

**Do not let the grand document replace the boring one.** The boring pilot deck is what gets the first counterparty.

---

## 10. What to say / not say

| Say | Do not say |
|---|---|
| “proof layer for commercial credit” | “another blockchain for payments” |
| “blockchain as court, not cash register” | “every transaction on-chain” |
| “instant bilateral commitment” | “absolute instant legal finality” |
| “edge exposure is capped; system risk must be managed” | “no contagion” |
| “credit only on reputational/regulated edges” | “provable stranger credit” |
| “external sources validate payment-infrastructure importance” | “World Bank/BIS prove XLN” |
| “mainnet requires audit, recovery, dispute drills and ops” | “production-ready because the invariant is elegant” |
| “GDP channels measured through pilots” | “guaranteed GDP growth” |

---

## 11. Presidential memo

A country does not need another speculative chain. It needs a verifiable commercial-credit layer.

Today, banks scale the economy through credit, but much of the credit state is opaque to customers, counterparties and sometimes even supervisors until stress appears. Crypto brought proof, but often removed the credit layer and tried to push routine commerce into public blockspace. XLN/RCPAN corrects the category error: keep commercial finance bilateral and credit-based, but make balances, limits, collateral and disputes cryptographically provable.

The chain becomes a digital commercial court. Banks and regulated hubs remain the credit layer. Fast commerce stays private between counterparties. When trust fails, signed evidence goes to the enforcement venue.

This does not eliminate crises. It gives the state a better map: signed exposures, collateral status, utilization, concentration and dispute evidence. The national strategy should not be “adopt XLN tomorrow.” It should be a regulated pilot: one institutional pair, collateral-heavy, audited, with forced recovery and dispute drills, plus a scorecard for payment cost, settlement time, locked collateral, reconciliation hours, recovery success and credit losses.

If the pilot improves those metrics, XLN becomes credible infrastructure for banks, PSPs, exporters, stablecoin operators, tokenized deposits and future AI-commerce.

---

## 12. Master prompt for other LLMs

```text
You are analyzing XLN/RCPAN.
Treat XLN/RCPAN first as a doctrine and mathematical architecture, not as a fully proven production deployment.

One-line definition:
XLN is not a blockchain for payments; it is a proof layer for commercial credit, with blockchain used only when trust fails.

Core invariant:
  -L_left <= Delta <= C + L_right
where Delta is the signed bilateral net balance, C is collateral anchored in a programmable settlement/enforcement venue, and L_left/L_right are directional bilateral credit limits.

Boundary cases:
- Banks are approximately C=0: credit without cryptographic customer/counterparty proofs.
- Lightning/payment channels are approximately L=0: proofs and collateral without native credit, creating inbound liquidity limits.
- RCPAN parameterizes both: collateral for unknown edges, credit for reputational/contractual/regulated edges.

Category correction:
Blockchain should be the court, not the cash register. The fast path is mutual bilateral signatures. The chain is used for collateral, disputes, exits and enforcement.

Critical caveats:
1. Say instant bilateral commitment, not absolute instant legal finality.
2. Link-capped loss is not topology-level systemic safety. Hub collapse can create correlated losses.
3. Creditworthiness of strangers is not provable on-chain. Stranger agents default to collateral-heavy rails.
4. Recovery and evidence availability are core security requirements, not UX extras.
5. External World Bank/BIS/ECB sources validate the importance of payment infrastructure and cross-border friction, not XLN itself.
6. Production readiness requires audit, recovery/watchtower reliability, dispute drills, operations, regulatory mapping and pilot data.

Task:
Explain why states, central banks, commercial banks, institutional crypto venues and AI-agent economies might need a verifiable bilateral account primitive. Emphasize lower reconciliation friction, lower idle collateral where credit is justified, faster bilateral settlement, better supervisory telemetry, and deterministic dispute resolution. Never claim credit risk disappears; say it becomes explicit, bounded per edge, reportable, stress-testable and enforceable.
```

---

## 13. Objection handling

**“This is just banking.”**  
It preserves the correct banking insight - bilateral credit - but adds signed account state, programmable collateral, dispute evidence and machine verification.

**“This is just Lightning.”**  
Lightning is the `L=0` full-reserve corner. RCPAN includes that mode, but also supports directional credit for known, reputational or regulated edges.

**“This creates credit risk.”**  
Yes. The claim is not that credit risk disappears. The claim is that credit risk becomes explicit, edge-bounded, signed, reportable, stress-testable and enforceable.

**“Hubs can still fail.”**  
Correct. Hub failure is the main systemic design concern. XLN must be paired with concentration limits, exposure reporting, collateral policy, capital buffers and resolution playbooks.

**“The chain is not a legal system.”**  
Correct. The chain is a programmable enforcement venue. Legal finality, admissibility and insolvency treatment depend on the jurisdiction and regulatory wrapper.

**“World Bank/BIS do not endorse XLN.”**  
Correct. They support the macro relevance of payment infrastructure, remittance-cost reduction, tokenized commercial-bank money and faster cross-border systems. XLN is a candidate architecture that must prove itself.

**“What is the first sellable wedge?”**  
Not a nation-scale deployment. Start with one institutional bilateral pair, one or two assets, collateral-heavy settings, forced dispute drills, recovery drills, external audit and a KPI report.

---

## 14. Source and proof map

| Claim area | Internal proof anchor | External macro anchor |
|---|---|---|
| RCPAN invariant | `docs/core/12_invariant.md`, `docs/intro.md`, `runtime/account-utils.ts` | none needed; mathematical design claim |
| Bilateral fast path | `runtime/account-consensus.ts`: account frames, signatures, commit path | none needed; implementation proof required |
| EVM as court/backstop | `Depository.sol`, `Account.sol`, `DeltaTransformer.sol`, dispute docs | CPMI-IOSCO principles for settlement risk context |
| Recovery/evidence risk | `docs/recovery-watchtower-protocol.md`, `runtime/dispute-arguments.ts` | Lightning watchtower/disaster-recovery lessons as analogy |
| Mainnet status | `docs/status.md`, `docs/mainnet.md`, external audit brief | none; must be proven by current release gates |
| Payment infrastructure importance | not XLN-specific | World Bank payment systems overview |
| Remittance friction | not XLN-specific | World Bank Remittance Prices Worldwide, Q3 2025 |
| Two-tier tokenized money direction | not XLN-specific | BIS Annual Economic Report 2025 |
| Cross-border interlinking | not XLN-specific | ECB / BIS-CPMI fast payment interlinking work |
| Systemic concentration risk | hub-exposure design | BCBS large-exposure and credit-concentration literature |

---

## 15. External references used in this brief

1. World Bank - Payment Systems overview: payment systems, FMIs and DFS support financial inclusion, economic development, digital economy and financial stability.  
   https://www.worldbank.org/en/topic/financialsector/brief/payment-systems
2. World Bank - Remittance Prices Worldwide: global average remittance cost 6.36% in Q3 2025.  
   https://remittanceprices.worldbank.org/
3. BIS - Annual Economic Report 2025, Chapter III: tokenised platforms with central bank reserves, commercial bank money and government bonds.  
   https://www.bis.org/publ/arpdf/ar2025e.htm
4. ECB - Enhancing cross-border payments in Europe and beyond, 2025: interlinking can reduce costs, increase speed/transparency and shorten transaction chains.  
   https://www.ecb.europa.eu/press/key/date/2025/html/ecb.sp250401~9e1ee05e88.en.html
5. BIS / CPMI - Interlinking fast payment systems, 2025: safe and efficient cross-border payments can lower cost, increase speed, transparency and access.  
   https://www.bis.org/cpmi/publ/brief7.pdf
6. BIS / BCBS - Large exposures standard executive summary: limits sudden counterparty-failure losses by requiring exposures be limited relative to capital.  
   https://www.bis.org/fsi/fsisummaries/lex.htm
7. BIS / BCBS - Studies on credit risk concentration: concentration of credit risk has been a major cause of bank distress.  
   https://www.bis.org/publ/bcbs_wp15.htm
8. CPMI-IOSCO - Principles for Financial Market Infrastructures: where central bank money is not used, credit and liquidity risk from commercial bank money should be minimized and controlled.  
   https://www.bis.org/cpmi/publ/d101a.pdf
