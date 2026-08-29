#!/usr/bin/env bash
set -euo pipefail
# Sync bb tasks agent presets with git-tracked JSON.
# Usage:
#   ./presets/sync.sh export   # dump local DB -> presets/tasks-presets.json
#   ./presets/sync.sh import   # upsert JSON -> local DB (by name)
#   ./presets/sync.sh diff     # show drift between DB and file

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="$ROOT/presets/tasks-presets.json"

export_preset() {
  bb tasks preset list --json | python3 -c "
import json, sys
data=json.load(sys.stdin)
out=[]
for p in data.get('presets', []):
    if p.get('builtin'):
        continue
    out.append({k: p[k] for k in ['name','providerId','modelId','reasoningLevel','serviceTier','permissionMode','environmentKind','baseBranch','machineId','instructions']})
json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
print()
" > "$FILE"
  echo "Exported $(python3 -c "import json; print(len(json.load(open('$FILE'))))") presets to $FILE"
}

import_preset() {
  python3 <<'PY'
import json, subprocess, pathlib, shlex
path = pathlib.Path("presets/tasks-presets.json")
presets = json.loads(path.read_text())
# fetch existing by name
import json as j, subprocess as sp
existing = json.loads(subprocess.check_output(["bb","tasks","preset","list","--json"], text=True))
by_name = {p["name"]: p for p in existing.get("presets", [])}
for preset in presets:
    name = preset["name"]
    args = ["bb","tasks","preset"]
    if name in by_name:
        args += ["update", name]
    else:
        args += ["create", "--name", name]
    # required fields for create; for update they become optional but we pass anyway
    for flag, key in [
        ("--provider","providerId"),("--model","modelId"),("--reasoning","reasoningLevel"),
        ("--permission","permissionMode"),("--environment","environmentKind"),
    ]:
        if preset.get(key) is not None:
            args += [flag, str(preset[key])]
    if preset.get("serviceTier") is not None:
        args += ["--service-tier", str(preset["serviceTier"])]
    else:
        args += ["--service-tier","none"]
    if preset.get("baseBranch"):
        args += ["--base-branch", preset["baseBranch"]]
    if preset.get("machineId"):
        args += ["--machine", preset["machineId"]]
    if preset.get("instructions") is not None:
        args += ["--instructions", preset["instructions"]]
    args += ["--json"]
    print(f"+ {' '.join(shlex.quote(a) for a in args)}")
    out = subprocess.run(args, capture_output=True, text=True)
    if out.returncode != 0:
        print(out.stderr or out.stdout)
        raise SystemExit(out.returncode)
    print(out.stdout.strip())
PY
}

diff_preset() {
  bb tasks preset list --json | python3 -c "
import json, pathlib, sys
db=json.load(sys.stdin)
db_presets=[{k:p[k] for k in ['name','providerId','modelId','reasoningLevel','serviceTier','permissionMode','environmentKind','baseBranch','machineId','instructions']} for p in db.get('presets',[]) if not p.get('builtin')]
file=json.loads(pathlib.Path('presets/tasks-presets.json').read_text())
import difflib
a=json.dumps(sorted(db_presets, key=lambda x: x['name']), indent=2, sort_keys=True).splitlines()
b=json.dumps(sorted(file, key=lambda x: x['name']), indent=2, sort_keys=True).splitlines()
diff=list(difflib.unified_diff(a,b, fromfile='local DB', tofile='git file', lineterm=''))
if diff:
    print('\n'.join(diff))
    sys.exit(1)
else:
    print('In sync — no drift')
"
}

case "${1:-}" in
  export) export_preset ;;
  import) import_preset ;;
  diff) diff_preset ;;
  *) echo "Usage: $0 {export|import|diff}" >&2; exit 1 ;;
esac
