#!/usr/bin/env bash
# Sync the Claude Max OAuth accessToken from ~/.claude/.credentials.json into the
# OneCLI vault entry that Andy uses, so Andy's container always has a fresh token.
#
# Triggered by the systemd path unit `claude-oauth-sync.path` whenever the
# credentials file is rewritten (which Claude CLI does after every refresh).
#
# Idempotent — exits silently when the vault already matches the file.

set -euo pipefail

CRED_FILE="$HOME/.claude-andy/.credentials.json"
SECRET_NAME="Claude Max OAuth (Andy, anthropic-typed)"
ANDY_AGENT_ID="f5abe959-c845-4166-83d5-8cf5fced7e0a"
LOG_FILE="$HOME/.claude/oauth-sync.log"

log() {
  echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"
}

if [[ ! -r "$CRED_FILE" ]]; then
  log "credentials.json missing or unreadable — nothing to sync"
  exit 0
fi

ACCESS_TOKEN=$(jq -r '.claudeAiOauth.accessToken // empty' "$CRED_FILE")
EXPIRES_AT=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CRED_FILE")

if [[ -z "$ACCESS_TOKEN" || "$ACCESS_TOKEN" == "null" ]]; then
  log "no accessToken in credentials.json — nothing to sync"
  exit 0
fi

# Look up the secret ID by name — never hardcode, the ID changes on delete+recreate.
SECRETS_JSON=$(onecli secrets list 2>/dev/null)
SECRET_ID=$(echo "$SECRETS_JSON" | jq -r ".[] | select(.name == \"$SECRET_NAME\") | .id // empty")

TOKEN_TAIL="${ACCESS_TOKEN: -4}"

if [[ -z "$SECRET_ID" ]]; then
  # Secret was deleted externally — recreate it and re-assign to Andy.
  log "secret not found in vault — recreating"
  NEW_ID=$(onecli secrets create \
    --name "$SECRET_NAME" --type anthropic \
    --value "$ACCESS_TOKEN" --host-pattern "api.anthropic.com" \
    2>/dev/null | jq -r '.id')
  # Preserve Andy's other secrets (Discord + Hindsight) and add the new one.
  OTHER_IDS=$(onecli agents secrets --id "$ANDY_AGENT_ID" 2>/dev/null \
    | jq -r '.[]' | grep -v "^$" | tr '\n' ',' | sed 's/,$//')
  SECRET_IDS="${NEW_ID}${OTHER_IDS:+,$OTHER_IDS}"
  onecli agents set-secrets --id "$ANDY_AGENT_ID" --secret-ids "$SECRET_IDS" >/dev/null 2>&1
  log "recreated secret $NEW_ID and assigned to Andy — token tail $TOKEN_TAIL"
  exit 0
fi

# Short-circuit if vault preview already matches current token tail.
VAULT_PREVIEW=$(echo "$SECRETS_JSON" | jq -r ".[] | select(.id == \"$SECRET_ID\") | .preview // empty")
if [[ -n "$VAULT_PREVIEW" && "$VAULT_PREVIEW" == *"$TOKEN_TAIL" ]]; then
  log "vault already matches token tail $TOKEN_TAIL — no-op"
  exit 0
fi

if onecli secrets update --id "$SECRET_ID" --value "$ACCESS_TOKEN" >/dev/null 2>&1; then
  log "vault updated — token tail $TOKEN_TAIL, expiresAt $(date -d @$((EXPIRES_AT/1000)) -Iseconds)"
else
  log "ERROR — onecli secrets update failed for id $SECRET_ID"
  exit 1
fi
