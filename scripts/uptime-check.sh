#!/usr/bin/env bash
# Uptime check for the owner's infrastructure (run by .github/workflows/uptime.yml every 15 minutes).
#   checks   iskra.foo and app.iskra.foo answer, chat.iskra.foo answers {"iskra":...} (and /health, once it has one:
#            voice up), the voice port 7881/tcp is reachable, and no TLS certificate expires within 14 days.
#   alerts   one GitHub issue labelled "outage" (not assigned, so no e-mail) plus a post to the Iskra channel (ISKRA_CI_WEBHOOK). It's opened when
#            something fails, commented on only when the set of failures changes, and closed when all is well again.
# Each check is tried 3 times, 20 s apart, so one dropped packet isn't an outage.
# Needs: curl, openssl, gh (GH_TOKEN with issues: write), GITHUB_REPOSITORY. DRY_RUN=1 only prints.
set -uo pipefail

SITE="${SITE:-https://iskra.foo}"
APP="${APP:-https://app.iskra.foo}"
CHAT="${CHAT:-https://chat.iskra.foo}"
VOICE_PORT="${VOICE_PORT:-7881}"
CERT_WARN_DAYS="${CERT_WARN_DAYS:-14}"
TRIES="${TRIES:-3}"
PAUSE="${PAUSE:-20}"
REPO="${GITHUB_REPOSITORY:-quikmn/iskra-voice}"
LABEL=outage
MARKER='<!-- uptime-monitor -->'

failures=()
failed=()
rows=()

# retry <description> <command...>: true if the command succeeds within $TRIES attempts.
retry() {
  local what="$1"; shift
  local i
  for ((i = 1; i <= TRIES; i++)); do
    if "$@"; then return 0; fi
    [ "$i" -lt "$TRIES" ] && sleep "$PAUSE"
  done
  echo "::warning::$what failed $TRIES times"
  return 1
}

check_page() { curl -fsS -o /dev/null --max-time 20 -H 'Cache-Control: no-cache' "$1/?uptime=$(date +%s)"; }
check_chat() { curl -fsS --max-time 20 "$CHAT/" | grep -q '"iskra"'; }
check_port() { timeout 10 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

# /health arrived after 2.0.0-alpha.10: a 404 means an older server, not a problem.
check_health() {
  local body code
  body="$(curl -sS --max-time 20 -w '\n%{http_code}' "$CHAT/health")" || return 1
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  [ "$code" = 404 ] && { HEALTH="(no /health on this version)"; return 0; }
  [ "$code" = 200 ] || return 1
  HEALTH="$(printf '%s' "$body" | tr -d '\n' | head -c 300)"
  # "off" is a choice; "down" means LiveKit isn't running.
  ! printf '%s' "$body" | grep -q '"voice":"down"'
}

# Days until the certificate served for host:443 expires; empty if it couldn't be read.
cert_days() {
  local end
  end="$(echo | timeout 20 openssl s_client -servername "$1" -connect "$1:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  [ -n "$end" ] || return 1
  echo $(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
}

record() { # record <ok|fail> <check> <detail>
  rows+=("| $([ "$1" = ok ] && echo '✅' || echo '❌') | $2 | $3 |")
  [ "$1" = ok ] && return
  failures+=("$2: $3")
  failed+=("$2")
}

if retry "$SITE" check_page "$SITE"; then record ok "iskra.foo" "answers"; else record fail "iskra.foo" "doesn't answer (HTTP error or timeout)"; fi
if retry "$APP" check_page "$APP"; then record ok "app.iskra.foo" "answers"; else record fail "app.iskra.foo" "doesn't answer (HTTP error or timeout)"; fi
if retry "$CHAT" check_chat; then record ok "chat.iskra.foo" "answers as an Iskra server"; else record fail "chat.iskra.foo" "doesn't answer as an Iskra server"; fi
HEALTH=""
if retry "$CHAT/health" check_health; then record ok "chat.iskra.foo/health" "${HEALTH:-ok}"; else record fail "chat.iskra.foo/health" "unhealthy or voice down: ${HEALTH:-no answer}"; fi
chat_host="${CHAT#https://}"
if retry "voice port" check_port "$chat_host" "$VOICE_PORT"; then record ok "voice $VOICE_PORT/tcp" "reachable"; else record fail "voice $VOICE_PORT/tcp" "not reachable on $chat_host"; fi

for url in "$SITE" "$APP" "$CHAT"; do
  host="${url#https://}"
  if days="$(retry "certificate $host" cert_days "$host")"; then
    days="$(printf '%s' "$days" | tail -n1)"
    if [ "$days" -lt "$CERT_WARN_DAYS" ]; then record fail "certificate $host" "expires in $days days"; else record ok "certificate $host" "$days days left"; fi
  else
    record fail "certificate $host" "couldn't be read"
  fi
done

{
  echo "### Uptime $(date -u '+%Y-%m-%d %H:%M UTC')"
  echo
  echo "| | Check | Result |"
  echo "|---|---|---|"
  printf '%s\n' "${rows[@]}"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

# ── alerting: only on a change of state ──
# The state is which checks fail, not the details ("expires in 9 days" → "8 days" isn't news).
key="$(printf '%s\n' "${failed[@]+"${failed[@]}"}" | sed '/^$/d' | sort | sha256sum | cut -c1-16)"
run_url="${GITHUB_SERVER_URL:-https://github.com}/$REPO/actions/runs/${GITHUB_RUN_ID:-0}"

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "dry run: ${#failures[@]} failing (state $key)"
  exit 0
fi

open="$(gh issue list -R "$REPO" --label "$LABEL" --state open --search "\"uptime-monitor\" in:body" --json number,body --limit 1 \
  --jq '.[0] | select(. != null) | "\(.number) \((.body | capture("<!-- state: (?<k>[0-9a-f]+) -->")? | .k) // "")"')" || { echo "::error::couldn't list issues"; exit 1; }
number="${open%% *}"
previous="${open#* }"

# The alert goes to the team's Iskra channel (the same webhook as CI and releases), not by e-mail. Only when set.
notify() {
  [ -n "${ISKRA_CI_WEBHOOK:-}" ] || return 0
  jq -n --arg c "$1" '{content: $c}' | curl -fsS -m 20 -H 'content-type: application/json' --data @- "$ISKRA_CI_WEBHOOK" >/dev/null     || echo "::warning::couldn't post to Iskra"
}

body() {
  printf '%s\n<!-- state: %s -->\n\nThe uptime check found problems with the infrastructure:\n\n' "$MARKER" "$key"
  printf -- '- %s\n' "${failures[@]}"
  printf '\nLast checked %s ([run](%s)). This issue closes by itself when every check passes again.\nPlaybook: docs/ci-cd-playbook.md → "Outage alert".\n' "$(date -u '+%Y-%m-%d %H:%M UTC')" "$run_url"
}

if [ "${#failures[@]}" -gt 0 ]; then
  if [ -z "$number" ]; then
    gh label create "$LABEL" -R "$REPO" --color B60205 --description "Opened by the uptime check" 2>/dev/null || true
    gh issue create -R "$REPO" --title "Outage: ${failures[0]%%:*}$([ "${#failures[@]}" -gt 1 ] && echo " (+$(( ${#failures[@]} - 1 )) more)")" \
      --label "$LABEL" --body "$(body)"
    notify "$(printf '🔴 Outage:
'; printf -- '- %s
' "${failures[@]}"; printf '%s' "$run_url")"
    echo "Opened an outage issue."
  elif [ "$previous" != "$key" ]; then
    gh issue edit "$number" -R "$REPO" --body "$(body)"
    gh issue comment "$number" -R "$REPO" --body "$(printf 'Failing now:\n\n'; printf -- '- %s\n' "${failures[@]}"; printf '\n[Run](%s)\n' "$run_url")"
    notify "$(printf '🟠 Outage changed, failing now:
'; printf -- '- %s
' "${failures[@]}"; printf '%s' "$run_url")"
    echo "Updated outage issue #$number."
  else
    echo "Still failing; issue #$number already says so."
  fi
  exit 0 # the issue is the alert; a red run would email a second time
fi

if [ -n "$number" ]; then
  gh issue close "$number" -R "$REPO" --comment "Every check passes again ($(date -u '+%Y-%m-%d %H:%M UTC'), [run]($run_url))."
  notify "🟢 Back up: every uptime check passes again. $run_url"
  echo "Closed outage issue #$number."
fi
echo "All checks pass."
