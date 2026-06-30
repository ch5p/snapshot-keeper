# ChatGPT Snapshot Keeper

Chrome MV3 extension for saving only explicitly marked ChatGPT assistant snapshot blocks.

Current MVP version: `0.3.30`

## What It Saves

Saved:

- Text between `SNAPSHOT_START turn=n` and `SNAPSHOT_END`.
- Only when the source is one confirmed assistant message node.
- Only on snapshot turns: `10, 20, 30...`.
- Markdown front matter metadata for saved, missing, invalid, and variant state records.

Not saved:

- Full user prompts.
- Full assistant answers outside snapshot markers, except an explicit user-clicked `Escape save` checkpoint.
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
### 제외된 주제
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

Recommended personal archive root:

```text
D:\_my_tools\ChatGPT_Snapshot_Archive\snapshots
```

This keeps runtime snapshots outside the extension source repository. The source repository may still contain old ignored `2026-*/` QA output, but normal use should select the external archive `snapshots` folder instead.

Example relative path:

```text
2026-06/2026-06-26_062911__c-6a3cbaed-9b18-83ee-a92/turn_0050__2026-06-26_062911__saved.md
```

## Archive Workflow

The extension only writes conservative source snapshots. Human-facing archive notes, handoff notes, and global search indexes are handled outside the extension by the snapshot archive workflow.

Recommended archive root:

```text
D:\_my_tools\ChatGPT_Snapshot_Archive\
├── README.md
├── snapshots\
├── archive\
├── index\
├── work\
└── skills\
```

Folder roles:

- `snapshots/`: source snapshot evidence written or collected from the extension.
- `archive/`: flat human-facing handoff/archive notes.
- `index/`: global search indexes such as `_index__snapshot_archive.md`.
- `work/`: temporary evidence packets and review preparation files. Repo-side QA/review outputs that would otherwise create `_qa` under this extension root belong in `D:\_my_tools\ChatGPT_Snapshot_Archive\work\extension_repo_qa`.
- `skills/`: source copy or backup of the archive/indexing skill, such as `conversation-snapshot-indexer`.

When preparing the next external AI review, include or mention the external archive workflow and the skill source copy under `ChatGPT_Snapshot_Archive\skills`. The reviewer should understand that source snapshots may live outside this code repository and that archive/handoff generation is intentionally handled by a separate skill/session.

Do not keep `_qa`, `__pycache__`, or other generated QA/cache folders inside the extension load root. Chrome's unpacked-extension loader rejects filenames and folders that start with `_`, even when Git ignores them. Keep those artifacts under the external archive `work/` folder instead.

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
- `Rescan`: rescan loaded snapshot candidates in the current chat DOM, including offscreen messages that are still loaded.
- `Escape save`: manually save the latest loaded assistant message as an `escape` checkpoint when the model is failing before the next scheduled snapshot turn. This is user-triggered only and is not treated as a normal `saved` snapshot.
- `Auto off` / `Auto on` / `Auto resume`: manually stop or restart live automatic capture. `Auto resume` clears a per-conversation quarantine after the guard pauses a noisy chat.
- `Open archive`: open the human-facing archive folder (`D:\_my_tools\ChatGPT_Snapshot_Archive\archive`) in a Chrome file tab.

The panel count grid shows `saved`, `missing`, `variant`, `escape`, and `auto`. Folder readiness is still checked when saving or rescanning, but the folder row is hidden to keep the panel compact. The `auto` row is `on`, `off`, or `paused`.

Developer-only retry, clear-error, and QA-save message handlers remain in the extension code, but those controls are intentionally hidden from the normal panel.

Chrome extensions cannot directly launch Windows Explorer without a local helper. Snapshot Keeper keeps this button as a file-tab shortcut so folder-opening helpers cannot interfere with snapshot saving.

Missing records are shown as distinct warning/error notices, not normal saved-success notices.

Current guarded live mode enables automatic capture for normal chats and disables it per conversation when a chat shows repeated unstable DOM behavior. Use `Auto off` to stop live capture globally while escaping a bad chat, `Auto on` to restart it, and `Auto resume` when the panel says auto is paused for the current chat.

`Escape save` writes to an `escape/` subfolder and stores only the latest assistant message currently loaded in the page. It exists for leaving a degraded conversation before turn 20/30/etc. arrives. It does not save user prompts, input-box text, or full conversation history.

If a save has already failed for a snapshot hash, automatic scans do not keep retrying it. Use `Set folder`, then `Rescan` for a user-triggered retry.

The floating bar remains in static UI mode: no waiting-dot animation, no watchdog remount loop, and no composer-anchor recalculation. Status changes can still happen from live snapshot detection and user actions.

`Rescan` runs in quiet UI mode. Intermediate save/missing/error notifications are counted silently and the bar updates once at the end with a summary.

Conversation identity is sticky during transient ChatGPT URL states. If ChatGPT briefly reports a URL without `/c/...`, the extension keeps the previous official conversation key instead of creating a new temporary `chatgpt:tab-*` key.

Status refresh sends the current page URL to the service worker. If the ChatGPT tab moved to another `/c/...` conversation and `webNavigation` missed the SPA transition, the status call rebinds the tab before rendering counts or latest state.

Once content/status has confirmed a `/c/...` route, a late `webNavigation` event for a different conversation is ignored. This prevents the panel from briefly switching to the correct chat and then reverting to stale counts from the previous chat.

Snapshot/turn candidates captured before a navigation epoch change are rejected as `stale_node_binding`. This prevents old DOM nodes from polluting the newly selected conversation after ChatGPT's SPA route changes.

Content bindings are refreshed against the current service-worker context before each candidate is processed. If a stale binding is still rejected, the content script marks that node/text as processed so it cannot retry the same stale event forever.

If the current visible turn is lower than stored history for the same conversation, the panel displays the visible turn and neutralizes old latest/missing status text. This prevents old `turn 20` records from making a newly loaded `turn 3` view look stuck on `20 -> 30`.

After a conversation route change, the panel no longer falls back to stored `lastSeenTurn` before the current visible turn is observed. It shows a neutral syncing state until live parsing confirms the visible turn.

The content UI honors `displayTurn: 0` from the service worker during sync instead of falling through to old `lastSeenTurn`, avoiding temporary mismatches such as `20 -> 10`.

Navigation epoch now advances only when the resolved conversation key changes. Path-only URL churn inside the same conversation updates the stored URL but does not reset visible turn state or restart capture epochs.

Manual `Rescan` scans loaded/offscreen snapshot candidates. Live automatic inspection is user-toggleable from the panel and stays enabled for normal chats by default, but a conversation is quarantined when path churn, stale bindings, repeated live missing, or repeated live turn observations cross the guard threshold. Path churn alone is enough to pause auto for that chat.

Content-to-background status messages carry the current `location.href` inside the extension payload. The service worker must read that payload URL before judging path churn; otherwise normal `content_context` refreshes can look like false path changes and pause auto incorrectly.

After a conversation context/epoch change, live automatic inspection waits briefly for the ChatGPT DOM to settle before trusting the first visible assistant candidate. This avoids transient `20 -> 30` flashes from stale visible nodes on broken conversations.

Live candidate selection uses assistant messages near the viewport, not only strictly intersecting the viewport. This prevents the panel from staying `SK ready` when ChatGPT's layout reports unusual element rectangles.

When current visible turn is lower than stored history, the panel suppresses that diagnostic detail in normal UI and shows neutral `ready` instead of exposing `stored history`.

## State Model

`chrome.storage.local` is the authoritative state ledger.

It keeps metadata such as:

- `appVersion`
- `gitCommit`
- `testMode`
- `scanMode`
- `uiState`
- `pathSchemaVersion`
- `writer`
- `conversationKey`
- `lastSeenTurn`
- `savedTurns`
- `missingTurns`
- `resolvedMissingTurns`
- `resolvedMissing`
- `variantTurns`
- `escapeRecords`
- `normalizedHash`
- `rawHash`
- `saveState`
- `filePath`
- timestamps
- display title

Snapshot bodies are not kept permanently in storage. Pending or failed bodies may be kept temporarily for retry, then removed after confirmation or cleanup.

`gitCommit`, `testMode`, and `uiState` are currently recorded as `null` unless a later build or QA workflow supplies them.

## Variant Metadata

A `variant` is created when the same `conversationKey + turn` is seen again with a different `normalizedHash`.

Variant records include comparison metadata so later QA can identify the base record:

- `variantOfTurn`
- `baseHash`
- `baseRawHash`
- `baseFilePath`
- `baseRecordType`
- `baseSaveState`
- `variantReason`
- `scanCause`

`scanCause` preserves the source that produced the variant, such as `latest`, `manual_rescan`, or `boot_scan`.

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

If a snapshot turn has markers but required sections are missing, the extension writes a `missing` record and shows a missing warning. If the final Korea time line never appears after retry limit, the extension writes a `missing` record with `korea_time_missing_after_retry_limit`.

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


