# Deferred items (out-of-scope failures detected during Phase 4 execution)

## Pre-existing (not caused by Plan 04-02)

### gmail.test.ts "defaults to unread query when no filter configured"
- **Status:** FAIL on main and on plan 04-02 branch base (033fbdb)
- **Expectation:** 'is:unread category:primary'
- **Actual:** 'is:unread -category:promotions -category:social -category:updates -category:forums'
- **File:** src/channels/gmail.ts
- **Plan 04-02 scope:** does NOT touch src/channels/gmail.*
- **Action:** flagged here; fix is its own plan.
