---
name: /add-discord skill leaves chat dep at incompatible version
description: Bug in nanoclaw's /add-discord skill — pins @chat-adapter/discord@4.27.0 without bumping host's top-level `chat` dep, causing TS build error from duplicate ChatInstance types.
type: project
originSessionId: 1797ab25-3535-43e5-92c8-c2b2ae9bca17
---
`/add-discord` (`.claude/skills/add-discord/SKILL.md`) installs `@chat-adapter/discord@4.27.0` but does not touch the project's top-level `chat` dep in `package.json`. If `chat` is pinned to anything below 4.27.0 (e.g. `^4.24.0`, which was the trunk default as of 2026-05-09), pnpm resolves two `chat` versions in node_modules — one for the host (4.26.0) and one transitive via the discord adapter (4.27.0) — and `tsc` fails with two distinct `ChatInstance` type signatures: "Type 'DiscordAdapter' is not assignable to type 'Adapter<unknown, unknown>'... Property 'processOptionsLoad' is missing in type 'chat@4.26.0'.ChatInstance' but required in type 'chat@4.27.0'.ChatInstance'".

**Why:** The skill assumes the host's `chat` dep already matches the adapter's, but trunk lags. Same shape probably applies to other `/add-<channel>` skills if they pin a chat-adapter to a version newer than trunk's `chat`.

**How to apply:** When running any `/add-<channel>` skill that installs `@chat-adapter/*`, after `pnpm install <pkg>@<version>` and before `pnpm run build`, check whether the top-level `chat` dep matches the adapter's pinned version. If it doesn't, bump `chat` in `package.json` to the same `^<adapter-version>` and reinstall. The version is already in the lockfile (transitive from the just-installed adapter), so it clears the `minimumReleaseAge` gate without needing a fresh resolution. Worth fixing the skill itself or filing upstream — the workaround should not be retained as tribal knowledge if a real fix is possible.
