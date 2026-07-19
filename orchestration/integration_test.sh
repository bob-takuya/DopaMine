#!/usr/bin/env bash
# End-to-end integration: drive a real study session against the live backend.
set -e
API=http://127.0.0.1:8000
PY=~/anki-addiction/.venv/bin/python
uuid() { $PY -c "import uuid;print(uuid.uuid4())"; }

echo "### Driving a 12-review live session (fsrs engine) ###"
for i in $(seq 1 12); do
  CARD=$(curl -s "$API/api/next-card?deck=DopaMine%20Demo")
  CID=$($PY -c "import sys,json;d=json.load(sys.stdin);print(d['card']['card_id'] if d.get('card') else '')" <<<"$CARD")
  if [ -z "$CID" ]; then echo "[$i] no card due — stopping"; break; fi
  # vary ratings: mostly Good(3), an Again(1) at #5 to test combo reset
  R=3; [ "$i" = "5" ] && R=1; [ "$i" = "9" ] && R=4
  RID=$(uuid)
  RESP=$(curl -s -X POST "$API/api/answer" -H 'content-type: application/json' \
    -d "{\"review_id\":\"$RID\",\"card_id\":\"$CID\",\"rating\":$R}")
  $PY - "$RESP" <<'PYEOF'
import sys,json
d=json.loads(sys.argv[1])
s=d.get('state',{}); rw=[e['type'] for e in d.get('rewards',[])]
loot=[e['payload'] for e in d.get('rewards',[]) if e['type'] in ('loot_dropped','near_miss')]
print(f"  xp={s.get('total_xp'):>4} lvl={s.get('level')} combo={s.get('combo')} streak={s.get('streak_days')} "
      f"rare_pity={s.get('rare_pity')} legendary_pity={s.get('legendary_pity')} | events={rw} {loot if loot else ''}")
PYEOF
done
echo "### Idempotency re-check: replay last review_id ###"
R2=$(curl -s -X POST "$API/api/answer" -H 'content-type: application/json' -d "{\"review_id\":\"$RID\",\"card_id\":\"$CID\",\"rating\":$R}")
echo "$R2" | $PY -c "import sys,json;d=json.load(sys.stdin);print('  replay version=',d['state']['version'],' (should equal prior, no double-count)')"
echo "### Guardrail toggle: enable no_dark_pattern_mode ###"
curl -s -X PUT "$API/api/config" -H 'content-type: application/json' -d '{"no_dark_pattern_mode":true}' \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print('  config=',d.get('config'))"
