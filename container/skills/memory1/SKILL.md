---
name: memory1
description: Stores and retrieves the owner's private long-term memory in memory1 - short facts, revisable wiki pages (LLM wiki) and immutable source documents such as contracts, insurance policies and official notices. Use when the user says "remember", "check memory", "write to memory", "what do we know about", "check the LLM wiki", "add a new LLM wiki page", "look it up in my documents" or "file this", or sends a document to keep.
---

# memory1

Three stores in one service, reached through the `memory1:*` tools (how a client connects is set by the deployment). Choose the store by **how the knowledge changes over time**, not by topic or length.

| Store | Holds | Behaviour | Tools |
|---|---|---|---|
| **Docs** (RAG) | immutable sources: contracts, policies, notices, reference texts | never edited; a new version is a new document that replaces the old one | `memory1:docs_list`, `memory1:docs_search`, `memory1:docs_read` |
| **Wiki** | mutable long-form knowledge: research, assessments, overviews, plans | one current page per topic, revised in place; git keeps history | `memory1:wiki_list`, `memory1:wiki_read`, `memory1:wiki_search`, `memory1:wiki_write` |
| **Facts** | mutable short statements: decisions, dates, status, preferences, pointers | fastest entry point; a change is a new time-stamped fact | `memory1:fact_recall`, `memory1:fact_retain` |

Why: a RAG finds text but cannot update it - stale chunks would contradict newer knowledge. So Docs only holds sources that stay true.

## Choosing the store

Ask: **can this become outdated?**
- No, it is an original source → Docs (see [reference/filing-documents.md](reference/filing-documents.md)).
- Yes, and it needs more than 1-2 sentences → Wiki, plus a pointer fact.
- Yes, and it fits in 1-2 sentences → Facts.

Changeable content never goes into Docs: an article about current products is summarised into a wiki page with source and date. Wiki pages may cite documents (`memory1://doc/<doc_id>` + page).

## Answering a question

1. `memory1:fact_recall` with a natural-language question.
2. Follow pointers in facts: `memory1://wiki/<path>` → `memory1:wiki_read`; `memory1://doc/<doc_id>` → `memory1:docs_read`.
3. Anything written in a contract, policy, notice or invoice: `memory1:docs_search`, then `memory1:docs_read` if the snippet is not enough.
4. `memory1:wiki_search` for exact words, `memory1:wiki_list` to browse.
5. An empty result in one store is no proof - check the others before saying "I don't know".

Name document and page for every statement from a document ("Home contents policy 2026, p. 3"). Hits with status `replaced` are hidden unless `include_replaced=true`; if you show one, say so and prefer the current version.

## Writing facts

One fact = one `memory1:fact_retain` call: 1-2 self-contained sentences with names, dates and amounts - no pronouns, no "recently". There is no delete: record a change as the new state ("As of 2026-10, X is no longer … but …").

## Writing wiki pages

1. `memory1:wiki_search` first - update the existing page instead of creating a second one.
2. `memory1:wiki_read`, then `memory1:wiki_write` with its `version` as `expected_version`. On `conflict`: re-read, merge, write again. New page: no `expected_version`.
3. First line `As of: YYYY-MM-DD` (last substantive update; in the owner's language if pages are written in it, e.g. `Stand:`). List sources (URLs, `memory1://doc/<doc_id>` + page).
4. Paths: lowercase `topic/sub-topic.md`; letters, digits, `-`, `_`, `/` only.
5. New page → pointer fact `"<one-sentence summary> - see memory1://wiki/<path>"`, then verify with `memory1:fact_recall("memory1://wiki/<path>")`. If a page changes a statement that also exists as a fact, retain the new state as a fact too.

When answering from a page on a fast-ageing topic (prices, products, markets), mention its date and offer to refresh it.

## Never store

Passwords, PINs, TANs, API keys, full account or card numbers - in any store. If asked, say memory1 is not meant for secrets.

## Errors

| Response | Meaning | Action |
|---|---|---|
| `locked` / HTTP 503 | vault is locked | tell the owner; do not retry in a loop |
| `missing scope …` | not permitted for this client | tell the owner; no workaround |
| `conflict` (wiki) | page changed since read | re-read, merge, write again |
| `fact store unavailable` | fact service down | answer from wiki/docs and say so |
| 401 | authentication failed | report as deployment problem; never send tokens yourself |
