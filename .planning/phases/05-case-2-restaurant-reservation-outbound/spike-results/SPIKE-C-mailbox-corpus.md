---
spike: C
task: 3
phase: 05
plan: 05-00
executed: 2026-04-20
method: desk-research (public sources, no live PSTN calls)
samples: 12
verdict: regex-hardened
verdict_confidence: high
---

# Spike-C — German Voicemail Greeting Corpus for AMD Regex Design (OQ A3/A5)

## Verdict: `regex-hardened`

Corpus of **12 distinct German voicemail greetings** assembled from public sources (carrier defaults, PBX defaults, professional-announcement catalogs, medical/business templates). Original CASE2_MAILBOX_CUE_REGEX from RESEARCH.md §2 matches **11/12** of realistic greetings. One edge case (permanent-absence reject) uncovered a gap → minimal regex extension covers **12/12**.

**Method:** chosen over live PSTN sampling per Carsten's 2026-04-20 decision. Provider documentation + community forums + professional voice-artist catalogs provide enough signal for regex tuning; live samples can be added during Wave 3 implementation if ASR transcripts expose additional phrasings.

## 1. Corpus (12 greetings)

| ID | Source | Text (verbatim / reconstructed) | Category |
|---|---|---|---|
| G01 | Vodafone Mailbox default (mobile) | "Guten Tag, Sie sind verbunden mit der Vodafone Mailbox von [Rufnummer]. Bitte sprechen Sie Ihre Nachricht nach dem Tonsignal." | carrier-default |
| G02 | Telekom Nichterreichbarkeits-Ansage (network-level reject, no voicemail) | "Die gewählte Rufnummer ist zur Zeit nicht erreichbar. Auf Wiederhören." | reject-style |
| G03 | Telekom Sprachbox standard | "Der von Ihnen gewünschte Teilnehmer ist zur Zeit nicht erreichbar. Sie können jetzt eine Nachricht hinterlassen." | carrier-default |
| G04 | o2 Mobilbox default | "Der gewünschte Gesprächspartner ist zur Zeit nicht erreichbar. Bitte hinterlassen Sie uns eine Nachricht nach dem Signalton." | carrier-default |
| G05 | Sipgate Basic voicemail default | "Der gewünschte Gesprächspartner ist derzeit nicht erreichbar. Bitte hinterlassen Sie uns eine Nachricht nach dem Signalton." | PBX-default |
| G06 | FritzBox Anrufbeantworter default | "Der Anruf kann im Moment nicht entgegengenommen werden. Bitte hinterlassen Sie eine Nachricht." | PBX-default |
| G07 | Private formal (custom) | "Guten Tag, Sie sind mit Max Muster verbunden. Leider bin ich gerade nicht erreichbar. Hinterlassen Sie mir bitte eine Nachricht nach dem Signalton." | personal |
| G08 | Private casual (custom) | "Hallo, hier ist die Mailbox von Anna. Ich bin grad nicht da — sprich mir nach dem Piep drauf, ich ruf zurück!" | personal-casual |
| G09 | Business receptionist (custom) | "Willkommen bei der Max Mustermann GmbH. Wir bedauern, dass wir im Moment nicht für Sie erreichbar sind. Bitte hinterlassen Sie Ihren Namen, Ihre Rufnummer und eine kurze Nachricht nach dem Piepton." | business |
| G10 | Business after-hours (custom) | "Sie haben die Fantasie GmbH erreicht. Zurzeit ist unser Büro geschlossen. Bitte hinterlassen Sie eine Nachricht oder rufen Sie zu unseren Geschäftszeiten zurück." | business-afterhours |
| G11 | Medical practice (Virchowbund template) | "Guten Tag, hier ist die Praxis Dr. Schmidt. Wir sind gerade nicht in der Praxis. Bitte sprechen Sie nach dem Ton." | medical |
| G12 | Edge: permanent-absence / reject-style | "Dieser Anschluss wird zurzeit nicht bedient. Auf Wiederhören." | edge (rare) |

## 2. Regex evaluation

### Original regex (RESEARCH.md §2)
```
/nicht erreichbar|bitte hinterlassen|anrufbeantworter|mailbox von|nach dem (signal|piep|ton)|sprach(nachricht|box)|ist zur zeit nicht/i
```

| ID | Match? | Trigger |
|----|--------|---------|
| G01 | ✓ | `mailbox von`, `nach dem …ton…` (via `ton` alt) |
| G02 | ✓ | `nicht erreichbar`, `ist zur zeit nicht` |
| G03 | ✓ | `nicht erreichbar`, `ist zur zeit nicht`, `Nachricht hinterlassen` (via `bitte hinterlassen` — close but needs `bitte` — matches "hinterlassen" via regex `bitte hinterlassen`? No — must be contiguous. Still matches via `nicht erreichbar`.) |
| G04 | ✓ | triple: `nicht erreichbar`, `bitte hinterlassen`, `nach dem (signal)` |
| G05 | ✓ | `bitte hinterlassen`, `nach dem signal` |
| G06 | ✓ | `bitte hinterlassen` |
| G07 | ✓ | `nicht erreichbar`, `nach dem (signal)` |
| G08 | ✓ | `mailbox von`, `nach dem (piep)` |
| G09 | ✓ | `bitte hinterlassen`, `nach dem (piep)` |
| G10 | ✓ | `bitte hinterlassen` |
| G11 | ✓ | `nach dem (ton)` |
| G12 | ✗ | none of the tokens present |

**Coverage:** 11/12 with original regex.

### Recommended extended regex (final)
```regex
/nicht\s+(mehr\s+)?erreichbar|bitte\s+hinterlassen|anrufbeantworter|mailbox\s+von|sprachbox|nach\s+dem\s+(signal(ton)?|piep(ton)?|ton(signal)?)|sprach(nachricht|box)|ist\s+zur\s+zeit\s+nicht|zur\s+zeit\s+nicht\s+erreichbar|im\s+moment\s+nicht\s+(erreichbar|da)|entgegen(nehmen|genommen)|anschluss.*(nicht\s+bedient|nicht\s+belegt|existiert\s+nicht)|b(ü|ue)ro\s+(ist\s+)?geschlossen|au(ß|ss)erhalb\s+.*(gesch(ä|ae)ftszeiten|sprechzeiten)/i
```

Changes vs. original:
- `\s+` tolerance across tokens (ASR transcripts sometimes collapse/expand whitespace)
- `zur zeit nicht erreichbar` as explicit token (original demanded the verb "ist")
- `im moment nicht (erreichbar|da)` — FritzBox + casual
- `entgegen(nehmen|genommen)` — FritzBox + onpulson business template
- `anschluss … nicht bedient/belegt/existiert nicht` — G12 coverage
- `büro geschlossen` + `außerhalb … geschäftszeiten/sprechzeiten` — G10, G11
- `mehr erreichbar` variant for "nicht mehr erreichbar" absence announcements

**Coverage after extension: 12/12.**

## 3. Risk analysis

### False-positive risk (human speech that could match the regex)

| Trigger phrase | Plausible human utterance | Severity |
|---|---|---|
| `bitte hinterlassen` | Human receptionist: "Sie können gerne eine Nachricht hinterlassen, Herr Müller ist im Meeting" | **HIGH** — same language a gatekeeper uses |
| `nicht erreichbar` | Human: "Chef ist gerade nicht erreichbar" | **HIGH** — identical verb |
| `nach dem ton/signal/piep` | Essentially never used outside voicemail context | **LOW** — strong signal |
| `mailbox von`, `sprachbox`, `anrufbeantworter` | Rarely at call-answer | **LOW** |
| `büro geschlossen`, `außerhalb geschäftszeiten` | Rare conversationally | **LOW** |
| `auf wiederhören` | Very common human closing | **CRITICAL — do NOT add unpositioned** |

**Mitigation strategy (locks in Wave 3 design):**
- Run regex only on first 4-6s of cumulative transcript after call-connect.
- High-specificity tokens (`nach dem signal/piep/ton`, `mailbox von`, `sprachbox`, `anrufbeantworter`) → immediate `machine` classification.
- Low-specificity tokens (`bitte hinterlassen`, `nicht erreichbar`) → downgrade to "suspected"; escalate to `machine` only if a second high-specificity token also fires OR if speech continues >6s without natural pause.

### False-negative risk (greetings that evade even the extended regex)

- **Fully custom branded** (e.g. "Hallo, Sie haben Paulas Pizzeria angewählt — wir melden uns zurück.") — no canonical tokens. Fallback: duration-based heuristic — if other side speaks >8s without yielding pause AND transcript doesn't contain human self-ID patterns (`ja`, `hallo`, `guten tag (X) (am apparat|hier|sprecher)`) → treat as suspected machine, silent hangup. False-positive on very chatty humans is the acceptable asymmetric trade-off given §201 StGB.
- **Noise-only / music-hold AB** — no transcript at all. Regex never fires. Out of scope for Spike-C; Wave 3 VAD-cadence gate (per Research) addresses.
- **Heavy ASR degradation** — "Mailbox" → "Maine Box", "Signalton" → "Sign alton". Mitigation: lowercase + whitespace-normalize transcript; fuzzy-match (Levenshtein ≤2) the 4 highest-value tokens: `mailbox`, `anrufbeantworter`, `sprachbox`, `signalton`.

### Operational AMD pattern (feeds Wave 3 Plan 05-03)

**Two-stage AMD** (supersedes Research §2.4 timer-based approach — Spike-A showed timer approach unreliable):

1. **Stage 1 (regex on transcript):** run extended regex on first 4-6s of cumulative transcript. High-specificity → immediate `machine` verdict. Low-specificity → `suspected`.
2. **Stage 2 (timing + negative human-ID):** if `suspected` or regex-negative but speech continues >6s uninterrupted, escalate to `suspected_machine`, silent hangup.

Legal risk asymmetry: §201 StGB violation on machine >> annoyance on long-winded human. Optimize for zero false-negatives, accept small false-positive rate on chatty humans.

## Closes Spike-C Success Predicate (from PLAN)

- [x] ≥10 distinct German mailbox greetings collected — 12 samples
- [x] Coverage table (greeting # | matches regex | proposed patch) — 12-row table above
- [x] Final regex recommendation (CASE2_MAILBOX_CUE_REGEX_V2) — documented in §2

## Carryforward to Wave 3 (Plan 05-03)

1. **Use extended regex** above as `CASE2_MAILBOX_CUE_REGEX_V2` constant in `voice-bridge/src/amd-classifier.ts`.
2. **Two-stage AMD pattern** replaces the timer-only approach from Research §2.4.
3. **Fuzzy-match Levenshtein ≤2** for 4 top tokens against ASR transcript to catch degraded transcriptions.
4. **Positional gating**: regex runs ONLY on cumulative transcript window of 0-6s post-accept; after that, switch to duration-based fallback.
5. **No live mailbox sampling needed** for Wave 3 start. If ASR transcripts in Wave 3 integration testing expose new phrasings, add to corpus as we go.

## Sources

- Vodafone InfoDok 318, Handyhase, Vodafone Community
- Telekom hilft Community, Telekom Sprachbox Kurzanleitung
- o2 Community, o2online Service
- Sipgate Hilfecenter, teltarif Sipgate SatelliteApp
- Computerwoche/Giga FritzBox docs
- Onpulson, telefonsounds, Karrierebibel, Virchowbund Praxisärzte-Blog, Sandra Litto templates
- Ansage-Anrufbeantworter, Appdated

Full URL list retained in the research subagent output (commit history).
