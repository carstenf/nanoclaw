---
name: method-distill
description: Distills a reusable, standalone method skill from work Carsten did with Andy - from a method-record log or retrospectively from the chat history - and refines existing method skills after they were applied again. Separates method from domain content, abstracts the steps to a problem class, asks Carsten up to three questions, and proves the method on a different case with a fresh subagent before anything is saved. Use when Carsten says "/distill", "mach daraus eine Methode", "leite die Methode ab", "wie sind wir vorgegangen - als Skill", "turn this into a method", after "/record stop", or "improve the <name> method". Not for tool or procedure skills (use learn).
---

# method-distill

A method skill tells a future agent how to *approach* a class of problems: which steps, in which order, for what purpose, with which checks and which of Carsten's working rules. It holds no findings. Findings live in the wiki and are only referenced.

Paths (container): records `/workspace/agent/methods/_records/`, chat export `/workspace/agent/methods/_chats/YYYY-MM-DD.md` (last 7 days, Carsten = `loger1`), staging `/workspace/agent/skills-staging/<name>/`, approved methods `/workspace/extra/skills/methods/<name>/` (git, index `methods/README.md`), guidelines `/workspace/extra/skills/_guidelines/README.md`. Output skeleton: [references/method-template.md](references/method-template.md).

Talk to Carsten in German; write the skill in English.

## Workflow

Copy and tick off:

```
- [ ] 1 Source   - [ ] 2 Events   - [ ] 3 Content vs method   - [ ] 4 Abstract
- [ ] 5 Ask Carsten   - [ ] 6 Draft   - [ ] 7 Transfer test   - [ ] 8 Review + fix
- [ ] 9 Show and wait for OK   - [ ] 10 Promote
```

1. **Source.** A record log if one exists for the work, plus the chat export for the same period (the log is the skeleton, the chat holds the detail), plus the wiki pages and own notes the work produced. Retrospective without log: find the period by searching the chat export for the topic; if start or end is unclear, ask. Older than 7 days: ask Carsten for the gist instead. Skip side topics that ran in between. Read the guidelines and list `/workspace/extra/skills/methods/`: if a method for the same problem class exists, this is a **refine** (see below).
2. **Events.** Without a log, extract events from the whole period, one line each: GOAL (goal stated/changed), FRAME (scope or constraint set), STEP (distinct step + purpose), CORRECTION (Carsten redirects; also a request he had to repeat because it was not done), DECISION (choice + criterion), DEADEND (dropped attempt + why), CHECK (how a result was challenged or verified), INSIGHT (lesson about the approach, not a domain fact), RESULT (where content went). Corrections are often short messages ("zu detailliert", "erst zusammenfassen"). Write the list to `/workspace/agent/methods/_records/<topic>-events.md` (create the folder if needed), never into the skill.
3. **Content vs method.** Sort every event: domain finding or number → content (check that it is in the wiki; if not, tell Carsten and offer to store it). Way of working → method. Done when no number, result or domain claim is left on the method side.
4. **Abstract.** Name the problem class in one sentence ("understand what drives a system's results before optimizing it"). Rewrite each step at that level, then test it twice:
   - *Transfer:* does the step make sense for two other cases in the class (one outside the original domain)? If not, it is case-bound: generalize it or move it to the example.
   - *Non-obvious:* would a capable generalist do this without being told? If yes, drop it unless Carsten's corrections show it was missed. A method made of obvious steps is worthless.
   This is a quick paper check; step 7 is the real test. Target 5-9 steps. Corrections become working rules. Mechanism vocabulary that fits the whole class is allowed in steps ("counterfactual", "path-dependent rule", "residual"); case nouns (instrument, product, place, tool names) belong only in the Example.
   If the work changed direction and its phases serve different problem classes (e.g. surveying the options vs. analysing one of them), propose one method per class and let Carsten decide in step 5.
5. **Ask Carsten** (one message, German) — first whether the result counts as good and whether the work is finished, then at most 3 questions — and show the draft problem class and step list (one line per step):
   - Which kinds of problems should this method cover, and which not? (Adjust the problem class to his answer.)
   - Which steps were essential, which were incidental?
   - Is there anything that must never happen again?
   Wait for the answer. Result not good: stop, no method from a bad result. Work unfinished: continue, but mark the method `Status: draft` and name the untested steps.
6. **Draft** `skills-staging/<name>/SKILL.md` from the template. Name: verb-object for the class (e.g. `analyze-return-drivers`), not the case. Target ≤ 80 lines in the file, one idea per line. Case specifics only in the Example section, which may name the wiki page and data folders.
7. **Transfer test.** Start two fresh subagents (Agent tool) that cannot see this chat, on a case Carsten names or, if none, one of your choosing from a different domain:
   - A: gets the SKILL.md and the case, returns a plan (no execution) plus a list of what in the skill was unclear, did not fit or seemed case-bound.
   - B: gets only the case, returns its plan (baseline).
   Compare the approach, not domain knowledge: what does A do that B does not (and Carsten would want)? What does B do well that the method should have prompted (e.g. a generic check A skipped because the method's wording steered it away)? If A adds nothing over B, the method is too generic: go back to step 4. Use one case from the original domain and one from outside it.
8. **Review + fix.** Fix every problem found in 7 and run the checks below. At most two test-fix rounds; after that report what is still weak.
9. **Show and wait.** German message: name, problem class, steps (one line each), working rules, transfer test result (A vs B in 3-5 lines), staging path. Ask for an explicit OK. Implied agreement is not an OK.
10. **Promote** after OK: copy to `/workspace/extra/skills/methods/<name>/`, add one line to `methods/README.md` (name, problem class, source date), commit (`git config --global --add safe.directory /workspace/extra/skills` once; `git -c user.name=andy -c user.email=andy@lenovo1 commit -m "methods/<name>: <what>"`), read the commit output, report the hash. Ask before deleting staging.

## Refine an existing method

After a method was applied again (or on request): compare what was actually done with the skill. Collect only differences that would change the next application: a step that was skipped for good reason, a new correction, a decision point that was missing. Copy the folder to staging, apply minimal edits, show a short diff summary, same OK gate, commit. Do not append near-duplicates; merge them.

## Checks before showing (step 8)

- [ ] Problem class named; "use when" and "not for" present.
- [ ] Every step has a purpose and a done-criterion.
- [ ] No domain numbers, findings, dates or names outside the Example.
- [ ] Every CORRECTION from the source is either a working rule or deliberately dropped (say why).
- [ ] Transfer test: A beat B on at least one substantive point.
- [ ] Description third person with trigger phrases; ≤ 80 lines (guideline hard limit 500).

## Pitfalls

- Summarizing the content of the session instead of the approach (the failure of the first attempt, `strategie-treiber-analyse`).
- Over-abstraction: steps like "understand the problem" or "review the result" carry no information. Keep what is specific about Carsten's way of working.
- Distilling from one unfinished run without saying so: mark the method `Status: draft` and say what is untested.
- Grading your own draft only. The transfer test exists because the author is the worst judge.
