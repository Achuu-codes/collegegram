#!/usr/bin/env bash
#
# A 60-second tour of the API. Requires the server running (npm run dev),
# plus curl and jq.
#
#     ./scripts/demo.sh
#
# Every response printed is real; nothing here is faked. The second half
# deliberately triggers failures, because how an API refuses a request is as
# much a part of its design as how it accepts one.
#
# Note on style: every JSON payload is built with `printf -v` into a variable
# rather than written inline. Inline escaped quotes inside a command
# substitution ("$(curl … -d "{\"a\":1}")") do not survive the second round of
# parsing — the backslashes reach the server, the body is rejected as malformed
# JSON, and curl silently issues the request twice. A variable has no escapes
# in it, so there is nothing to re-parse.
set -euo pipefail

API="${API:-http://localhost:5050}"
SUFFIX="$RANDOM"
PASSWORD="correct-horse-battery-staple"

say() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# This script registers three accounts, and registration is capped at 3 per
# hour per IP — so a second run inside the hour would be rejected. Clear the
# limiter's own counters first (they are all namespaced `cg:rl:`) so the demo
# is repeatable. The limiter is then demonstrated for real at the end, on a
# clean window.
if command -v redis-cli >/dev/null 2>&1; then
  redis-cli eval "for _,k in ipairs(redis.call('keys','cg:rl:*')) do redis.call('del',k) end" 0 \
    >/dev/null 2>&1 || true
fi
post() { curl -s -X POST "$API$1" -H 'content-type: application/json' -d "$2"; }
code() { curl -s -o /dev/null -w '%{http_code}' -X POST "$API$1" -H 'content-type: application/json' -d "$2"; }
auth_post() {
  curl -s -X POST "$API$1" -H "Authorization: Bearer $2" -H 'content-type: application/json' -d "$3"
}

printf -v SIGNUP '{"email":"alice%s@mit.edu","username":"alice%s","displayName":"Alice","password":"%s"}' \
  "$SUFFIX" "$SUFFIX" "$PASSWORD"
printf -v LOGIN '{"identifier":"alice%s@mit.edu","password":"%s"}' "$SUFFIX" "$PASSWORD"
printf -v WRONG '{"identifier":"alice%s@mit.edu","password":"wrong-password"}' "$SUFFIX"

say "Readiness — reports each dependency, not just a 200"
curl -s "$API/health/ready" | jq -c

say "Register — the college comes from the email domain"
ALICE=$(post /auth/register "$SIGNUP")
ALICE_TOKEN=$(echo "$ALICE" | jq -r '.data.accessToken // empty')
[ -n "$ALICE_TOKEN" ] || die "register failed: $(echo "$ALICE" | jq -c .error) — is the server running on $API?"
echo "$ALICE" | jq -c '.data.user | {username, collegeDomain, role, reputation}' 

say "The refresh cookie: httpOnly, SameSite=Strict, scoped to /auth"
curl -s -i -X POST "$API/auth/login" -H 'content-type: application/json' -d "$LOGIN" \
  | grep -i '^set-cookie' | sed 's/cg_refresh=[^;]*/cg_refresh=<redacted>/'

say "Post — the college is taken from the author, NOT from the body below"
printf -v NEW_POST '%s' '{"title":"Best coffee on campus","body":"Asking for a friend with an 8am lecture.","collegeDomain":"harvard.edu"}'
POST=$(auth_post /posts "$ALICE_TOKEN" "$NEW_POST")
echo "$POST" | jq -c '.data.post | {title, collegeDomain, score, commentCount}'
POST_ID=$(echo "$POST" | jq -r .data.post.id)

say "A second user votes — one vote per user, enforced by a unique index"
printf -v BOB_SIGNUP '{"email":"bob%s@mit.edu","username":"bob%s","displayName":"Bob","password":"%s"}' \
  "$SUFFIX" "$SUFFIX" "$PASSWORD"
BOB_TOKEN=$(post /auth/register "$BOB_SIGNUP" | jq -r .data.accessToken)
vote() {
  local body
  printf -v body '{"value":%s}' "$1"
  auth_post "/posts/$POST_ID/vote" "$BOB_TOKEN" "$body" | jq -c .data
}

echo "  upvote        → $(vote 1)"
echo "  same again    → $(vote 1)   # idempotent: not counted twice"
echo "  flip to down  → $(vote -1)  # a delta of 2, not 1"
echo "  retract       → $(vote 0)"
echo "  upvote again  → $(vote 1)"

say "Ten concurrent identical votes — exactly one is counted"
for _ in $(seq 10); do vote 1 >/dev/null & done; wait
curl -s "$API/posts/$POST_ID" -H "Authorization: Bearer $BOB_TOKEN" | jq -c '.data.post | {score, myVote}'

say "Comment"
printf -v COMMENT '%s' '{"body":"Second floor of the library, no question."}'
auth_post "/posts/$POST_ID/comments" "$BOB_TOKEN" "$COMMENT" \
  | jq -c '.data.comment | {body, author: .author.username}'

say "Feed — myVote is per viewer, applied after the shared cache read"
curl -s "$API/posts?sort=top" -H "Authorization: Bearer $BOB_TOKEN" \
  | jq -c '.data.items[0] | {title, score, commentCount, myVote, author: .author.username}'
curl -s "$API/posts?sort=top" -H "Authorization: Bearer $ALICE_TOKEN" \
  | jq -c '.data.items[0] | {title, score, myVote}  # same post, different viewer'

say "Now the refusals. NoSQL operator injection:"
printf -v INJECT '%s' '{"identifier":{"$ne":null},"password":{"$ne":null}}'
post /auth/login "$INJECT" | jq -c '.error | {code, message}'

say "Privilege escalation at signup — undeclared keys are stripped"
printf -v ESCALATE '{"email":"mallory%s@mit.edu","username":"mallory%s","displayName":"Mallory","password":"%s","role":"admin","reputation":99999}' \
  "$SUFFIX" "$SUFFIX" "$PASSWORD"
post /auth/register "$ESCALATE" | jq -c '.data.user | {username, role, reputation}'

say "Deleting someone else's post (IDOR) — authenticated, still refused"
curl -s -X DELETE "$API/posts/$POST_ID" -H "Authorization: Bearer $BOB_TOKEN" | jq -c '.error | {code, message}'

say "Voting on your own post"
printf -v UP '%s' '{"value":1}'
auth_post "/posts/$POST_ID/vote" "$ALICE_TOKEN" "$UP" | jq -c '.error | {code, message}'

say "Brute force — 5 login attempts per 15 min, per IP and per account"
printf '  '
for _ in $(seq 6); do printf '%s ' "$(code /auth/login "$WRONG")"; done
printf '\n  401 while the budget lasts, then 429 with Retry-After.\n'
printf '  The successful login above already spent one, so the fifth is over budget.\n'

say "An unknown route still answers in the one error shape, with a request id"
curl -s "$API/nope" | jq -c .error

printf '\n\033[1;32m✓ demo complete\033[0m\n'
