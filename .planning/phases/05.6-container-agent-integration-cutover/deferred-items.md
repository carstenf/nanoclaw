
## Deferred (Phase 05.6 Plan 01)

### gmail.test.ts pre-existing failure (out of scope)

- **File:** `src/channels/gmail.test.ts`
- **Test:** GmailChannel > constructor options > defaults to unread query when no filter configured
- **State:** FAIL on `worktree-agent-a5f8c550` BEFORE Plan 05.6-01 changes were applied (verified via `git stash` + re-run).
- **Scope:** Plan 05.6-01 does not touch `src/channels/gmail.ts` or its test. Out of scope per executor Rule SCOPE BOUNDARY.
- **Action:** Track for Phase 05.7+ Gmail-channel maintenance pass. Do NOT block Plan 05.6-01.
