# Keepers that failed their customers — checked list for the wall (part 1)

Checked on 23 November 2026 from regulator, court, trustee and top-tier press sources. The film may
say "missing", "frozen", "cut", "owed". It may not say customers "lost everything": several were
repaid, years later. Change a figure here first, then in `design/film/scenes/ch1.js`.

| On the wall | Kind | When | Figure, and what it measures | What happened to customers | Source |
|---|---|---|---|---|---|
| FTX | exchange | Nov 2022 | about $8.7 bn of customer deposits misappropriated | repaid in cash at Nov 2022 dollar values under a plan confirmed Oct 2024 | https://www.theblock.co/post/236474/ftx-com-exchange-owed-customers-8-7-billion-debtors-say |
| Mt. Gox | exchange | Feb 2014 | 850,000 BTC reported missing in the filing | partial repayment began July 2024; deadline now Oct 2027 | https://www.mprnews.org/story/2014/02/28/bitcoin-exchange-mtgox-files-for-bankruptcy |
| Bitfinex | exchange | Aug 2016 | 119,756 BTC stolen; 36.067% cut from every customer balance | IOU tokens redeemed within eight months | https://fortune.com/2016/08/15/bitfinex-bitcoin-hack-hong-kong-customers-law/ |
| QuadrigaCX | exchange | early 2019 | C$215 m owed to over 76,000 clients | interim 13 cents on the dollar, May 2023 | https://osc.ca/quadrigacxreport/index.html |
| Celsius | lender | June–July 2022 | over $4.7 bn owed to users; $1.19 bn deficit | partial recovery, estimated 67–85% | https://blockworks.com/news/celsius-faces-heat-for-1-2b-balance-sheet-hole-customers-owed-4-7b |
| Gemini Earn (Genesis) | lender | Nov 2022 | about $940 m of users' assets frozen; about 232,000 users | 97% of coins returned in kind after 18 months | https://gemini.com/blog/gemini-earn-users-receive-usd2-18-billion-of-their-digital-assets-in-kind-a |
| MF Global | broker | Oct 2011 | $1.2 bn shortfall in segregated customer funds (CFTC); press said $1.6 bn | repaid in full after about two and a half years | https://www.cftc.gov/PressRoom/PressReleases/6904-14 |
| Madoff | broker / adviser | Dec 2008 | $64.8 bn shown on statements; about $17.5 bn of real principal | about $15.5 bn recovered by Oct 2026; still open | https://www.madofftrustee.com/facts-08.html |
| Synapse | fintech app middleware | May 2024 | $219 m of end-user funds frozen; $65–96 m shortfall | 87% returned by Jan 2025; deposit insurance did not apply | https://banking.senate.gov/imo/media/doc/synapse_letter.pdf |
| Bank of Cyprus | bank | Mar 2013 | 47.5% of deposits above €100,000 converted into shares | insured deposits untouched | https://www.startribune.com/bank-of-cyprus-depositors-lose-47-5-percent-of-uninsured-savings-as-part-of-national-bailout/217376361/ |
| Lebanon | banks | since Oct 2019 | financial-sector losses over $72 bn (World Bank) | deposits remain frozen | https://www.worldbank.org/en/news/press-release/2022/11/23/lebanon-time-for-an-equitable-banking-resolution |
| Silicon Valley Bank | bank | Mar 2023 | over $40 bn withdrawn on 9 March | all depositors made whole by a government exception | https://www.federalreserve.gov/publications/2023-April-SVB-Executive-Summary.htm |

Not used, and why: Wirecard (the missing €1.9 bn was the company's own claimed cash, not customer
balances); Bybit (customers were not hurt); Voyager and BlockFi (no primary figure for claims).

Statistics that may be said aloud:

- Roughly 40% of deposits in US banks are uninsured (43.3% at commercial banks, Q4 2025; St. Louis
  Fed, April 2026: https://www.stlouisfed.org/on-the-economy/2026/apr/banking-analytics-uninsured-deposit-ratio-back-prepandemic-level).
- Over $3.4 bn was stolen from crypto platforms in 2025 (Chainalysis, 18 Dec 2025:
  https://www.chainalysis.com/blog/crypto-hacking-stolen-funds-2026/).
- 576 US bank failures from 2001 through 2026 (FDIC: https://www.fdic.gov/resources/resolutions/bank-failures/in-brief).
- FTX: the November 2022 filing estimated more than one million creditors.

## Deposit insurance, to scale (part 1, beats 1.2-1.3) — checked 24 November 2026

- FDIC Deposit Insurance Fund balance, end of Q2 2026: $161.1 bn; reserve ratio 1.48% (the fund divided by estimated
  insured deposits). Source: https://bankingjournal.aba.com/2026/08/quarterly-banking-profile-banking-net-income-90-1b-in-q2-2026/
  and https://www.fdic.gov/news/press-releases/2026/fdic-insured-institutions-reported-return-assets-137-percent-and-net
- Domestic deposits of FDIC-insured institutions: NOT stated as a total on those pages. Derived: "+$142.7 bn, or 0.8%, in Q2"
  gives about $17.8 tn (between $16.8 tn and $19.0 tn for 0.75%-0.85%). The film says "about eighteen trillion".
  Fund / all deposits = about 0.9%, under 1% across that whole range: "less than one cent for every dollar".
  Before a public release, replace the derived total with the figure from the FDIC Quarterly Banking Profile tables.
- EU: the Deposit Guarantee Schemes Directive 2014/49/EU sets a target level of 0.8% of covered deposits. From memory of
  the directive, not re-opened today: re-check before release.
- SVB, March 2023: all depositors were covered under a systemic risk exception (already in the table above).
- No longer said in the film: "576 bank failures", "about 40% of deposits are uninsured".

## Added 24 November 2026 for v12 (all from memory of earlier research; re-open each before a public release)

- Fedwire Funds: 2025 average about $4.59 tn a day (Federal Reserve Fedwire statistics).
- Bitcoin: about 21,900 reachable nodes (Bitnodes, November 2026). The film says "about twenty-two thousand computers".
- After FTX (November 2022), large exchanges published proof-of-reserves within weeks: Binance on 25 Nov 2022,
  then Kraken, OKX, Crypto.com and others in Nov-Dec 2022. Used in 5.2 as the precedent for keepers moving
  when one moves. NOT re-sourced today.
- FTX plan (confirmed October 2024): customers paid in cash at November 2022 dollar values; most received
  about 118-119% of the dollar claim. The film says "the bankruptcy pays it back, at 2022 prices".
- Madoff: about $15.5 bn recovered of about $17.5 bn principal (trustee) = about 89%: "about 90% of principal back".

- 4.3 precedent (from memory, re-check before release): BCBS-IOSCO margin requirements for non-centrally cleared
  derivatives (2013, revised 2015; phased in from September 2016): daily variation margin, initial margin, and an
  unsecured initial-margin threshold of up to EUR 50 million per counterparty group. The film says "After 2008,
  regulators made the big banks deal with each other this way: collateral posted, an agreed unsecured limit, the
  balance marked every day."
