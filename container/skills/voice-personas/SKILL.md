---
name: voice-personas
description: When voice_triggers_init or voice_triggers_transcript fires, load the matching case-overlay from overlays/{case_type}.md, merge with baseline.md, substitute placeholders, return the rendered string as instructions.
---

# voice-personas — persona assembly for the voice channel

This skill owns the persona content for the NanoClaw voice channel. The container-agent invokes it whenever the Bridge fires `voice_triggers_init` (synchronous, at `/accept`) or `voice_triggers_transcript` (per-turn). The skill renders a fully-substituted instruction string the Bridge can hand directly to the OpenAI Realtime session.

NanoClaw owns the persona — the Bridge has zero persona text beyond a minimal `FALLBACK_PERSONA` constant (REQ-DIR-18, MOS-4 anchor: "alle Brain-Funktionen bleiben im NanoClaw-Core").

## When to invoke

Two MCP triggers fire this skill on the NanoClaw side:

| Trigger | When | What it returns |
|---|---|---|
| `voice_triggers_init` | Once, synchronously at `/accept` (call-setup) | `{ instructions: string }` — initial fully-rendered persona |
| `voice_triggers_transcript` | Per counterpart turn (FIFO per `call_id`) | `{ instructions_update: string \| null }` — `null` if no update needed, else full re-rendered persona |

Both triggers receive `case_type` (e.g. `case_2`, `case_6b`) plus call metadata. The skill picks the matching overlay and merges with the baseline.

## Files

| File | Purpose |
|---|---|
| `baseline.md` | Universal baseline (~515 tokens). Identity, ROLE, PERSONALITY, REFERENCE PRONUNCIATIONS, INSTRUCTIONS/RULES, CONVERSATION FLOW, SAFETY & ESCALATION. Holds all `{{...}}` placeholders. |
| `overlays/case-2-restaurant-outbound.md` | Case-2 overlay — outbound restaurant reservation. TASK + DECISION RULES + CLARIFYING-QUESTION ANSWERS + HOLD-MUSIC HANDLING. |
| `overlays/case-6b-inbound-carsten.md` | Case-6b overlay — inbound from Carsten (CLI whitelist). TASK + KALENDER-TERMIN-EINTRAG/LOESCHEN/AENDERN + FAHRZEIT-ANFRAGE + OFFENE FRAGEN. |

Case-3 / Case-4 overlays are added in later phases. Case-1 (hotel) is deferred to v2+.

## Assembly steps

The container-agent performs these steps verbatim when a trigger fires:

1. Read `baseline.md`.
2. Read `overlays/{case_type}.md` (mapping table below). If the overlay file does not exist, use baseline only and log a warning.
3. Concatenate `baseline.md` body + `\n\n` + overlay body into one string.
4. Substitute every `{{placeholder}}` token (see Placeholders below). After substitution there must be no `{{...}}` tokens left.
5. Return the rendered string as `instructions` (init) or `instructions_update` (transcript).

The Bridge receives a fully-rendered string with no `{{...}}` tokens left. The Bridge does NOT do any substitution.

## case_type-to-overlay mapping

| `case_type` | Overlay file |
|---|---|
| `case_2` | `overlays/case-2-restaurant-outbound.md` |
| `case_6b` | `overlays/case-6b-inbound-carsten.md` |
| (any other) | none — baseline only, log warning |

## Placeholders

The following `{{...}}` tokens appear in `baseline.md` and the overlays. The container-agent substitutes them during assembly step 4.

### Baseline placeholders (9 — sourced from `voice-bridge/src/persona/baseline.ts:60-72`)

| Token | Source | Description |
|---|---|---|
| `{{goal}}` | trigger arg | Task summary, 1-2 sentences (from container-agent task context) |
| `{{context}}` | trigger arg | Call context — e.g. restaurant+date or "inbound from Carsten's CLI" |
| `{{counterpart_label}}` | trigger arg | Counterpart noun phrase, e.g. "Bella Vista" or "Carsten" |
| `{{call_direction}}` | trigger arg (`inbound` or `outbound`) | Informs SCHWEIGEN ladder selection + SAFETY scope |
| `{{anrede_form}}` | derived from `case_type` (see below) | `Du` or `Sie` |
| `{{anrede_capitalized}}` | derived from `anrede_form` | `dich` (Du) or `Sie` (Sie) — accusative re-ask form |
| `{{anrede_pronoun}}` | derived from `anrede_form` | `du` (Du) or `Sie` (Sie) — nominative re-ask form |
| `{{anrede_disclosure}}` | derived from `anrede_form` | `Bist du` (Du) or `Sind Sie` (Sie) — bot-disclosure question form |
| `{{SCHWEIGEN_LADDER}}` | direction-conditional block (see below) | Outbound vs inbound silence-nudge ladder |

### Case-2 overlay-specific placeholders (sourced from `voice-bridge/src/persona/overlays/case-2.ts:46-71`)

| Token | Description |
|---|---|
| `{{restaurant_name}}` | Restaurant name (sanitized — curly braces stripped at trigger boundary) |
| `{{requested_date}}` | ISO date `YYYY-MM-DD` |
| `{{requested_date_wort}}` | Spoken date form, e.g. "dreiundzwanzigsten Mai" |
| `{{requested_time}}` | 24h time `HH:MM` |
| `{{requested_time_wort}}` | Spoken time form, e.g. "siebzehn Uhr" |
| `{{party_size_wort}}` | Spoken party-size, e.g. "vier" |
| `{{notes}}` | Special requests (sanitized) — falls back to "keine" if absent |
| `{{time_tolerance_min}}` | Integer minutes tolerance for counter-offers |

### `{{SCHWEIGEN_LADDER}}` direction-conditional convention

`baseline.md` ships TWO labelled blocks delimited by HTML comments. The container-agent picks the one matching `call_direction` and substitutes its body for the `{{SCHWEIGEN_LADDER}}` token. The OTHER block is dropped from the rendered output.

```
<!-- BEGIN SCHWEIGEN_LADDER call_direction=inbound -->
... inbound ladder text ...
<!-- END SCHWEIGEN_LADDER -->
<!-- BEGIN SCHWEIGEN_LADDER call_direction=outbound -->
... outbound ladder text ...
<!-- END SCHWEIGEN_LADDER -->
```

This mirrors the legacy `OUTBOUND_SCHWEIGEN` / `INBOUND_SCHWEIGEN` constants in `voice-bridge/src/persona/baseline.ts:36-58` — exactly one ladder ends up in the rendered persona; the other constant is not referenced, preventing cross-contamination.

## Du/Sie derivation

The init schema (`voice_triggers_init`) does NOT pass `anrede_form`. The skill derives it from `case_type`. Substitution is performed by the container-agent BEFORE returning `instructions`. Bridge receives a fully-rendered string with no `{{...}}` tokens left.

Derivation rule: `anrede_form = "Du" if case_type === "case_6b" else "Sie"`. Downstream tokens (`anrede_capitalized`, `anrede_pronoun`, `anrede_disclosure`) are computed from `anrede_form`.

| case_type | anrede_form | anrede_capitalized | anrede_pronoun | anrede_disclosure |
|---|---|---|---|---|
| `case_6b` | `Du` | `dich` | `du` | `Bist du` |
| (any other, e.g. `case_2`) | `Sie` | `Sie` | `Sie` | `Sind Sie` |

Values transcribed verbatim from `voice-bridge/src/persona/baseline.ts:161-163`:
```
const anredeCap  = args.anrede_form === 'Du' ? 'dich' : 'Sie'
const anredePron = args.anrede_form === 'Du' ? 'du'   : 'Sie'
const anredeDisc = args.anrede_form === 'Du' ? 'Bist du' : 'Sind Sie'
```

The downstream tokens cover the four substitution slots used in the baseline (re-ask accusative, re-ask nominative, bot-disclosure question, plus `anrede_form` itself for the "Anrede:" line). Examples of the resulting tone-shift the agent must produce when rendering: Sie-form sentences address the counterpart with `Sie` / `Ihnen` (e.g. "Ich verstehe Sie", "Ich sage Ihnen Bescheid"), Du-form sentences address Carsten with `du` / `dir` (e.g. "Ich verstehe dich", "Ich sage dir Bescheid"). Both `Ihnen` (Sie-form dative) and `dir` (Du-form dative) are valid surface forms the model produces from the derived `anrede_form`; they are NOT separate substitution tokens in the template (only the four columns above are).

The init schema stays minimal (D-8: only `call_id`, `case_type`, `call_direction`, `counterpart_label`); the skill is self-sufficient (REQ-DIR-18).

## ASCII-umlaut convention

All persona content uses ASCII umlauts (`ae` / `oe` / `ue` / `ss`) per `voice-bridge/src/persona/baseline.ts:12-13`. Examples: `Gegenueber`, `erfinde`, `unterwuerfig`, `Geraeusche`, `Bueros`, `fuer`, `Wuensche`. Do NOT introduce non-ASCII umlauts when editing the `.md` files — the OpenAI Realtime model has demonstrated stable pronunciation under this convention.

## Out of scope

- **Case-3 / Case-4 overlays.** Added in later phases when those call flows ship.
- **Case-1 (hotel) overlay.** Deferred to v2+.
- **Placeholder-substitution engine.** This is container-agent code, not part of this skill — the skill ships content only.
