---
name: method-record
description: Records HOW Carsten and Andy work through a problem (goal, steps and their purpose, Carsten's corrections, decisions with criteria, dead ends, checks) into a log file while the work happens, so a reusable method can be distilled later with method-distill. Use when Carsten says "/record start <topic>", "/record stop", "/record note <text>", "/record status", "Aufnahme starten/stoppen", "nimm das auf", or when the file /workspace/agent/methods/_records/.active exists. Records method events only, never domain content.
---

# method-record

Keeps a running log of the way of working, not of the results. The log survives context compaction because it lives in a file; `method-distill` turns it into a method skill afterwards.

Paths: logs in `/workspace/agent/methods/_records/<slug>.md`; the active recording is named in `/workspace/agent/methods/_records/.active` (one line: the slug). Chat history as files: `/workspace/agent/methods/_chats/YYYY-MM-DD.md` (host export, every 15 min, last 7 days; Carsten appears as `loger1`).

## Commands

| Command | Action |
|---|---|
| `/record start <topic>` | Slug from topic (kebab-case, add `-2` if it exists). Create the log with the header below, write the slug to `.active`, reply one line in German ("Aufnahme läuft: <topic>"). If another recording is active, ask whether to stop it first. |
| `/record note <text>` | Append `NOTE` with Carsten's words. |
| `/record status` | Reply: topic, start time, number of events, last 3 events. |
| `/record stop` | Run the stop procedure below. |

Log header:

```
# Record: <topic>
Started: <YYYY-MM-DD HH:MM> (Europe/Berlin)
Goal: <Carsten's goal in one sentence, or "open">
```

## While recording

After each turn in which a method event happened, append it to the log **before** you send the reply (one `Write`/append per turn is enough). One line per event, max two sentences:

`- [HH:MM] TYPE: <what> — <why / implied rule>`

| TYPE | Record when |
|---|---|
| GOAL | The goal or question is stated or changes. |
| FRAME | Scope, constraints or risk limits are set ("theory first", "no backtests yet"). |
| STEP | A distinct step starts: what is done and what it is for. |
| CORRECTION | Carsten redirects you ("too detailed", "first summarize, then critique") or has to repeat a request that was not done. Always record these; add the rule they imply. They are the most valuable events. |
| DECISION | A choice between options: the choice, the alternatives, the criterion. |
| DEADEND | Something was tried and dropped, and why. |
| CHECK | How a result was verified or challenged (critical review, cross-check, test). |
| INSIGHT | A lesson about the approach that would hold for another case. Domain facts are not insights. |
| RESULT | Where the content ended up (wiki page, file), as a pointer only. |
| NOTE | Carsten's own annotation via `/record note`. |

Write it so a reader without the chat understands the step, but keep domain numbers, findings and data out: those belong in the result (wiki/files), referenced by RESULT. Example of the difference:
- Good: `STEP: decomposed the return into components with a measurable proxy each — to see which driver can be monitored ex ante`
- Bad: `STEP: theta-gamma net was 1.27 M, drift -288k`

Do not mention the recording in replies unless asked; it runs silently.

## Stop procedure

1. Append `- [HH:MM] END`.
2. Gap check: read the chat export for the recording period and add missed events, marked `[backfilled]`. Check especially for CORRECTION and DECISION events.
3. Delete `.active`.
4. Reply in German: number of events, the corrections found (one line each), and ask: "Soll ich daraus jetzt eine Methode destillieren?" On yes, use `method-distill` with this log.

## Pitfalls

- Logging content instead of method: the log then distills into a domain summary, the failure this skill exists to prevent.
- Logging every tool call: only distinct steps matter; tool mechanics are noise.
- Forgetting the log after context compaction: the `.active` file is the signal; check it when unsure.
