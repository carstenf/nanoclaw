## Session reset (`reset_session`)

Use **`reset_session`** to end your own session and continue in a fresh context instead of letting auto-compaction drop details:

1. Write a complete handover file first (what you are doing, the next concrete step, relevant paths and results).
2. Make sure no background subagent is still running — its result would land in the old session. Prefer subagents that write results to files.
3. Call `reset_session({ handover_path: "/workspace/agent/UEBERGABE.md", reason: "context 125k > 120k, phase 2 step 4" })` (optional `resume_prompt`).
4. End your turn with a short note to the user. After the turn the runner archives the transcript, posts a notice, and starts a fresh session with the resume prompt in the same conversation.

Limits: only your own session; not in task runs; the handover must be non-empty and written in the last 30 min; at most one reset per 15 min and 6 per 24 h. A refusal says why.
