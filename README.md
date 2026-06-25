# ChatGPT Snapshot Keeper

Chrome MV3 extension MVP for saving only marked assistant snapshot blocks from ChatGPT.

## Scope

Saved content:

- Text between `SNAPSHOT_START turn=n` and `SNAPSHOT_END` inside a single confirmed assistant message.
- Metadata-only `missing.md` records when turn 10/20/30... is complete but snapshot markers or required sections are missing.

Not saved:

- Full user prompts.
- Full assistant answers outside snapshot markers.
- Text from the input box or ChatGPT UI.

## MVP storage location

Files are written under the user-selected folder via the floating bar `Set folder` button.

Inside that selected folder, files use the relative path stored in markdown front matter, for example `2026-06/session/turn_0030__...__saved.md`.

## Required ChatGPT instruction

```text
Every assistant answer starts with ## turn=n.
Every 10 turns, produce this snapshot block:

SNAPSHOT_START turn=n
### 현재 진행 중인 주제
### 새로 확정된 사항
### 미확정 사항
### 제외된 주제 (1회 기록)
### 앞으로 할 일
SNAPSHOT_END

Every answer ends with:
대한민국 기준 시각: YYYY.MM.DD(요일) HH:MM
```

## Permissions

- `storage`: authoritative per-conversation state ledger.
- `tabs`: current tab context.
- `webNavigation`: SPA navigation tracking and `navigationEpoch` updates.

## Important contracts

- Content scripts only create snapshot/missing/invalid candidates. They do not directly mutate conversation state in `chrome.storage.local`.
- `missing_candidate` does not include the assistant body.
- `SNAPSHOT_START turn=n` and `## turn=n` mismatch is recorded as `invalid_snapshot`, not `missing`, and no file is saved.
- File write success is confirmed only after the File System Access writer completes.
- Confirmed snapshot bodies are not kept permanently in `chrome.storage.local`.
