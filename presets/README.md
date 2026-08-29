# Tasks Agent Presets

Trackable `bb tasks` agent presets. These are `bb tasks preset` definitions committed to git so they survive across machines and can be restored with one command.

Source of truth: `tasks-presets.json` (array of preset objects). IDs and timestamps are omitted — `name` is the unique key.

## Sync

Export current presets from the local tasks DB:
```sh
bb tasks preset list --json | python3 presets/export.py > presets/tasks-presets.json
# or
./presets/sync.sh export
```

Import/restore presets to the local DB (upserts by `name`):
```sh
./presets/sync.sh import
# or manually:
bb tasks preset create --name "Chief of Staff" --provider pi --model "opencode-go/glm-5.3-flash" --reasoning high --permission full --environment project-default --instructions "$(cat presets/instructions.md)"
```

The sync script is idempotent — re-running `import` updates existing presets by name instead of creating duplicates.
