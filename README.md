# ChatGPT Snapshot Keeper

Chrome MV3 extension for saving only explicitly marked ChatGPT assistant snapshot blocks.

Current MVP version: `0.2.7`

## What It Saves

Saved:

- Text between `SNAPSHOT_START turn=n` and `SNAPSHOT_END`.
- Only when the source is one confirmed assistant message node.
- Only on snapshot turns: `10, 20, 30...`.
- Markdown front matter metadata for saved, missing, invalid, and variant state records.

Not saved:

- Full user prompts.
- Full assistant answers outside snapshot markers.
- ChatGPT input box text.
- ChatGPT UI text mixed into the page.
- `missing.md` original assistant body.

## Required ChatGPT Instruction

```text
Every assistant answer starts with:
## turn=n

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

## Save Location

The extension writes files through the File System Access API.

1. Open ChatGPT.
2. Click the Snapshot Keeper compact bar.
3. Click `Set folder`.
4. Choose the root folder where snapshots should be written.

The selected folder is treated as the root. The extension does not add an extra `ChatGPT-Snapshots/` wrapper.

Example relative path:

```text
2026-06/2026-06-26_062911__c-6a3cbaed-9b18-83ee-a92/turn_0050__2026-06-26_062911__saved.md
```

## Floating Bar

Default compact display:

```text
SK · turn {turn} → {next} · saved {saved}
```

While ChatGPT is generating or the live scanner is waiting for a stable assistant response, the compact display changes to:

```text
SK · waiting...
```

Details and actions are hidden by default. Hover or click the compact bar to open the panel.

The bar is anchored to the ChatGPT composer/input area instead of the full browser viewport, with viewport center as fallback.

Panel actions:

- `Set folder`: choose or refresh the writable snapshot folder.
- `Rescan`: rescan visible assistant messages only.
- `Retry`: retry the latest failed save.
- `Clear errors`: clear failed pending/error bodies.
- `QA save`: write a small QA file through the same save engine.

## State Model

`chrome.storage.local` is the authoritative state ledger.

It keeps metadata such as:

- `conversationKey`
- `lastSeenTurn`
- `savedTurns`
- `missingTurns`
- `variantTurns`
- `normalizedHash`
- `rawHash`
- `saveState`
- `filePath`
- timestamps
- display title

Snapshot bodies are not kept permanently in storage. Pending or failed bodies may be kept temporarily for retry, then removed after confirmation or cleanup.

## Detection Rules

A valid saved snapshot requires:

- `## turn=n`
- turn is a multiple of 10
- one confirmed assistant source node
- matching `SNAPSHOT_START turn=n`
- matching `SNAPSHOT_END`
- required five sections inside the markers
- final Korea time line
- generation idle / text stable checks

If `SNAPSHOT_START turn=n` and `## turn=n` disagree, the result is `invalid_snapshot`, not `missing`.

Inline prose mentions of `SNAPSHOT_START` or code block examples are not counted as control markers.

## Privacy Boundary

The extension intentionally limits what it stores:

- It saves only the marked assistant snapshot block.
- It does not save user prompts.
- It does not save the full general assistant response.
- It does not read or save ChatGPT input box content.
- It does not force-scroll old conversation history.

## Permissions

- `storage`: conversation state ledger.
- `tabs`: current tab context.
- `webNavigation`: SPA navigation tracking and tab-level navigation epoch.
- ChatGPT host permissions: content script injection on ChatGPT pages.

## Debug Mode

Debug logs are off by default.

Enable debug logs in the ChatGPT tab console:

```js
localStorage.setItem("snapshotKeeperDebug", "1")
```

Disable:

```js
localStorage.removeItem("snapshotKeeperDebug")
```

Reload the ChatGPT tab after changing the flag.

## Development Notes

- `content/content-script.js`: DOM detection, parser input extraction, floating bar, File System Access writer.
- `background/service-worker.js`: state ledger, record creation, save state transitions, content-script write requests.
- `content/floating-bar.css`: compact bar and expanded panel styling.
- `options/`: extension options/privacy text.

Runtime snapshot output folders such as `2026-*/` are excluded from git.


