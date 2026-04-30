---
name: voice-personas
description: When voice_triggers_init or voice_triggers_transcript fires, load i18n/{lang}/baseline.md + the matching i18n/{lang}/overlays/{case_type}.md, substitute placeholders, return the rendered string as instructions. Default lang=de; en + it supported.
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

Multilingual layout (Phase 06.x — 2026-04-28). Per-language baselines +
overlays under `i18n/{lang}/`. Renderer reads from `i18n/{lang}/` based on
the `lang` arg passed to `voice_triggers_init`; default `lang='de'`.

| File | Purpose |
|---|---|
| `i18n/{de,en,it}/baseline.md` | Universal baseline (~515 tokens). Identity, ROLE, PERSONALITY, REFERENCE PRONUNCIATIONS, INSTRUCTIONS/RULES, CONVERSATION FLOW, SAFETY & ESCALATION. Holds all `{{...}}` placeholders. |
| `i18n/{de,en,it}/overlays/case-6b-inbound-operator.md` | Case-6b overlay — inbound from {{operator_name}} (CLI whitelist). TASK + calendar / travel-time / ASK_CORE / END_CALL hard-rule. |

**Outbound (case_2 / generic) renders baseline-only (Step 2B 2026-04-28).**
The case-2 restaurant overlay was deleted; the call brief now flows in via the `goal` placeholder Andy supplied to `voice_request_outbound_call`, and `counterpart_label` addresses the right entity. Sonnet/Realtime is fully capable of handling restaurant reservations, doctor appointments, callbacks, and generic inquiries straight from the goal text. If a future case demands scripted decision rules (e.g. legal-style negotiations), introduce a new overlay file rather than reviving the case-2 one.

Languages supported v1: `de` (default), `en`, `it`. Adding a new overlay or
case_type means adding it for EVERY supported language — the loader has a
defensive flat-fallback (legacy `baseline.md` + `overlays/`) but those
files do not exist in v1, so a missing language file causes an `agent_unavailable`
that the Bridge surfaces via FALLBACK_PERSONA.

Case-3 / Case-4 overlays are added in later phases. Case-1 (hotel) is deferred to v2+.

## Assembly steps

The container-agent performs these steps verbatim when a trigger fires:

1. Resolve `lang` (default `'de'` if omitted).
2. Read `i18n/{lang}/baseline.md`.
3. Read `i18n/{lang}/overlays/{case_type}.md` (mapping table below). If the overlay file does not exist, use baseline only and log a warning.
4. Concatenate baseline body + `\n\n` + overlay body into one string.
5. Substitute every `{{placeholder}}` token (see Placeholders below). After substitution there must be no `{{...}}` tokens left.
6. Return the rendered string as `instructions` (init) or `instructions_update` (transcript).

The Bridge receives a fully-rendered string with no `{{...}}` tokens left. The Bridge does NOT do any substitution.

## case_type-to-overlay mapping

Paths are relative to `i18n/{lang}/`.

| `case_type` | Overlay file |
|---|---|
| `case_6b` | `overlays/case-6b-inbound-operator.md` |
| `case_2` | none — baseline only (Step 2B). Restaurant overlay was deleted; goal text drives the brief. |
| (any other) | none — baseline only, log warning |

## Placeholders

The following `{{...}}` tokens appear in `baseline.md` and the overlays. The container-agent substitutes them during assembly step 4.

### Baseline placeholders (sourced from `src/voice-agent-invoker.ts`)

| Token | Source | Description |
|---|---|---|
| `{{goal}}` | trigger arg | Task summary, 1-2 sentences (from container-agent task context) |
| `{{context}}` | trigger arg | Call context — e.g. restaurant+date or "inbound from operator's CLI" |
| `{{counterpart_label}}` | trigger arg | Counterpart noun phrase, e.g. "Bella Vista" or the operator's name |
| `{{call_direction}}` | trigger arg (`inbound` or `outbound`) | Informs SCHWEIGEN ladder selection + SAFETY scope |
| `{{anrede_form}}` | derived from `case_type` (see below) | `Du` or `Sie` |
| `{{anrede_capitalized}}` | derived from `anrede_form` | `dich` (Du) or `Sie` (Sie) — accusative re-ask form |
| `{{anrede_pronoun}}` | derived from `anrede_form` | `du` (Du) or `Sie` (Sie) — nominative re-ask form |
| `{{anrede_disclosure}}` | derived from `anrede_form` | `Bist du` (Du) or `Sind Sie` (Sie) — bot-disclosure question form |
| `{{assistant_name}}` | `ASSISTANT_NAME` env (default `Andy`) | Name the bot uses to identify itself |
| `{{operator_name}}` | `OPERATOR_NAME` env (lang-neutral fallback when unset) | Name of the operator the bot serves; appears throughout baseline + the case-6b overlay |
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

## Anrede derivation (lang-aware)

The init schema (`voice_triggers_init`) does NOT pass `anrede_form`. The skill derives it from `(case_type, lang)`. Substitution is performed by the container-agent BEFORE returning `instructions`. Bridge receives a fully-rendered string with no `{{...}}` tokens left.

| lang | case_type | anrede_form | anrede_capitalized | anrede_pronoun | anrede_disclosure |
|---|---|---|---|---|---|
| `de` | `case_6b` | `Du` | `dich` | `du` | `Bist du` |
| `de` | (other) | `Sie` | `Sie` | `Sie` | `Sind Sie` |
| `it` | `case_6b` | `tu` | `te` | `tu` | `Sei` |
| `it` | (other) | `Lei` | `Lei` | `Lei` | `Lei e'` |
| `en` | (any) | `you` | `you` | `you` | `Are you` |

`en` has no T-V distinction — all four slots collapse to "you" / "Are you". `de` and `it` keep the {{operator_name}}-vs-counterpart axis (Du/tu for {{operator_name}} via case_6b, Sie/Lei for any outbound counterpart).

The init schema stays minimal (D-8: only `call_id`, `case_type`, `call_direction`, `counterpart_label`, plus optional `lang`); the skill is self-sufficient (REQ-DIR-18).

## ASCII-umlaut convention (DE only)

`i18n/de/` content uses ASCII umlauts (`ae` / `oe` / `ue` / `ss`) per `voice-bridge/src/persona/baseline.ts:12-13`. Examples: `Gegenueber`, `erfinde`, `unterwuerfig`, `Geraeusche`, `Bueros`, `fuer`, `Wuensche`. Do NOT introduce non-ASCII umlauts when editing DE `.md` files — the OpenAI Realtime model has demonstrated stable pronunciation under this convention.

`i18n/en/` does not need this convention. `i18n/it/` may use plain ASCII (`e'`, `Lei e'`, `cosi'`, `piu'`) or accented characters depending on what the OpenAI Realtime model handles best for IT — current files use the ASCII apostrophe form for consistency with the DE policy and to avoid encoding-roundtrip risk over MCP/JSON.

## Out of scope

- **Case-3 / Case-4 overlays.** Added in later phases when those call flows ship.
- **Case-1 (hotel) overlay.** Deferred to v2+.
- **Placeholder-substitution engine.** This is container-agent code, not part of this skill — the skill ships content only.
