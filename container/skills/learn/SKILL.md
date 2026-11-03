---
name: learn
description: Distills a reusable skill from a path, URL, pasted notes or the current conversation, or refines an existing skill with new learnings. Use when Carsten says "/learn", "learn this", "turn this into a skill", "capture this workflow", "make a skill from <source>" or "improve/update the <name> skill". Output is always written to /workspace/agent/skills-staging/<name>/ first and promoted only after Carsten's explicit OK. Creates or refines skills; does not install skills from a registry.
---

# learn - distill a skill from anything

Turns a source (directory, URL, pasted notes, or the work just done in this conversation) into a clean skill, or refines an existing one. Instruction-only: use `Read`, `Grep`, `Glob`, `WebFetch`, `Write`. No separate engine.

## Problem class

Use when a procedure was worked out once and should be repeatable: "next time X comes up, what exact steps, files, commands and gotchas apply?"
Do not use to install or import community skills, to write one-off documentation, or to store facts (facts go to memory).

## Locations

| Path | Role |
|---|---|
| `/workspace/agent/skills-staging/<name>/` | Staging. Every new or refined skill is written here first (host: `groups/dm-with-carsten/skills-staging/<name>/`). |
| `/workspace/extra/skills/<name>/` | Shared domain skill repo (git, = `/opt/skills` on the host). Promotion target for trading/quant skills. |
| `/home/node/.claude/skills/<name>/` | Installed container skills, read-only for this purpose (copied from the host repo `container/skills/`; edits are lost on restart). |
| `/workspace/extra/skills/_guidelines/README.md` | Central guidelines. Read before drafting; skim `anthropic/best-practices.md` for frontmatter rules. |

## Workflow

1. **Identify source and mode.** Path, URL, pasted text, or "what we just did". Check `/workspace/extra/skills/` and `/home/node/.claude/skills/` for an existing skill on the topic; if one exists it is a REFINE. If the intended behavior is ambiguous, ask one clarifying question.
2. **Read the guidelines** (path above). Do not skip, even for small skills.
3. **Gather material.** Path: `Glob` structure, `Read` key files, `Grep` entry points; read enough to see the repeatable procedure. URL: `WebFetch`, extract commands and steps, not prose. Conversation: re-read what was actually run, which decisions were made, what went wrong.
4. **Write test scenarios first** (at least three realistic ones, guideline rule 10) so the draft is shaped by what must work.
5. **Draft in staging.**
   - New: write `/workspace/agent/skills-staging/<kebab-name>/SKILL.md` (plus optional `scripts/`, `references/`).
   - Refine: copy the whole existing folder into staging, edit the copy, never the live one. Keep what is still correct, merge new learnings into the right section, dedupe, fix what the new source proves stale, keep name and structure.
6. **Critical review pass.** Re-read the draft as a separate reviewer against the source and the checklist below; fix every finding before showing anything.
7. **Validate.** Frontmatter parses, `name` equals folder name, description at most 1024 chars, body under 500 lines. If the skill has scripts, run them on real data.
8. **Show Carsten and wait.** Short summary: skill name, destination, what it does; for a refine a short diff summary (`diff -ru <live> <staging>`, condensed). Do not promote without his explicit OK.
9. **Promote after OK** (see Decision points). Then ask whether to remove the staging folder; remove only if he agrees.

### Required sections in every generated skill

Each generated SKILL.md needs these English headings (content in the user's language only if he asks):

- **Problem class** - what class of problems; when to use, when not.
- **Workflow** - numbered steps.
- **Decision points** - where to choose, and by what criterion.
- **Pitfalls** - the gotchas actually hit; the most valuable part. Do not invent hypothetical ones.
- **Acceptance checks** - how to know the result is right; at least three realistic test scenarios.
- **Example** - one worked example. Concrete specifics from the source (dates, IDs, paths, numbers) live only here.

Frontmatter: `name` (kebab-case, matches folder), `description` (third person, what it does plus when to use it plus trigger phrases, max 1024 chars). House style: English, concise, Claude already knows general things, add only what it does not.

### Review checklist (step 6)

- Missing decision points: every "it depends" in the source has a criterion?
- Untested claims: each command, path and number was run or read, not assumed? Mark anything unverified.
- Overfit to the example: one-off dates, block/run IDs, names only in Example?
- No secrets, credentials or time-sensitive facts in the main text.
- Size under 500 lines; long detail moved to `references/` (one level deep; TOC if over 100 lines).
- Description third person with real trigger phrases; terminology consistent.
- Degrees of freedom: exact steps only where mistakes are costly.
- All six required sections present.

## Decision points

| Question | Criterion |
|---|---|
| New or refine? | Existing skill covers the topic or Carsten names one: refine. Otherwise new. Partial overlap: refine if the core procedure is the same, else new and cross-reference. |
| Where to promote? | Domain/trading/quant skill (TradeBlocks, strategies, data pipelines, plots): `/workspace/extra/skills/<name>/`. Skill about how the agent itself works (memory, messaging, scheduling, own tooling): host repo `container/skills/`, which the agent cannot write. Unclear: ask Carsten. |
| One skill or several? | One capability per skill; split if the description needs "and" for unrelated triggers. |
| Scripts or prose? | Prose when Claude can follow it with existing tools; a script only where mistakes are costly or logic is deterministic. |
| Ask or proceed? | Ask only if the skill's purpose is ambiguous; otherwise draft and let the review gate catch the rest. |

Promotion, domain skill:

```bash
git config --global --add safe.directory /workspace/extra/skills   # once per session
cp -r /workspace/agent/skills-staging/<name> /workspace/extra/skills/<name>
cd /workspace/extra/skills && git add <name> && git -c user.name=andy -c user.email=andy@lenovo1 commit -m "<name>: <what>"
```

Read the commit output before reporting success. For a refine, replace the live folder contents with the staged copy (check `git status` shows only intended changes).
Promotion, agent tooling: tell Carsten the staging path so he copies it to `container/skills/` on the host and restarts the instance.

## Pitfalls

- Editing the live copy of a skill during a refine. Always edit the staged copy.
- Writing to `/home/node/.claude/skills/`: it works but vanishes on restart.
- Promoting on an implied OK. Only an explicit OK counts.
- Appending a near-duplicate step or gotcha during a refine instead of merging it.
- Copying example specifics (dates, block IDs, run IDs) into the generic sections.
- Skipping the review pass because the draft "looks fine"; the author is the worst reviewer of their own draft.
- Pasting secrets or credentials seen in the source into the skill.
- Forgetting `safe.directory`, so git fails with "dubious ownership"; the commit then silently did not happen if the output is not read.

## Acceptance checks

- Frontmatter parses, `name` equals folder, description at most 1024 chars, body under 500 lines.
- The six required headings are present in the generated skill.
- Nothing was written outside staging before Carsten's OK; for a refine, the live folder is unchanged (`diff -r` against its original state).
- After promotion: `git log -1 --stat` shows the new commit with only `<name>/` files.

Test scenarios:
1. `/learn what we just did` after a multi-step data import: a new skill appears in staging with gotchas from the actual run; nothing in `/workspace/extra/skills`.
2. "update the vrp-plot skill" with a new flag: staged copy of the full folder, minimal diff, live folder untouched until OK.
3. `/learn <url>` of an API doc page: staged skill with concrete commands, no prose copied; asked where to promote because it is not clearly trading-related.

## Example

Carsten: "Make a skill from how we captured that OO backtest." Source: the conversation. Steps: read guidelines, list the commands run and the two failures hit (path outside data root, lock on the database), write the three scenarios, draft `/workspace/agent/skills-staging/oo-capture-notes/SKILL.md` with the six sections (IDs and dates only in Example), run the review checklist (found: one unverified flag, removed), validate, show a 5-line summary, get "ok", classify as domain skill, copy to `/workspace/extra/skills/oo-capture-notes/`, commit, report the commit hash, ask whether to delete staging.
