# ChatGPT Snapshot Keeper Handoff

## Hot Debug Rule

When Snapshot Keeper looks stuck, flickers, shows an old turn range, stops scanning, or pauses auto in a normal-looking chat, inspect the service-worker state events first. Do this before changing code.

Run this in the ChatGPT page DevTools console:

```js
chrome.storage.local.get("snapshotKeeperState").then((s) => {
  const state = s.snapshotKeeperState;
  console.log(state?.tabs);
  console.log(state?.conversations);
  console.log((state?.events || []).slice(-20));
});
```

The last 20 events are the primary evidence. Look for:

- `auto_capture_disabled_for_conversation`: check `reason`, `pathChurn`, `staleCount`, `missingCount`, `repeatedTurn`.
- `tab_context_updated`: check `conversationKey`, `navigationEpoch`, `pathChanged`, `conversationChanged`, `source`.
- `stale_navigation_context_ignored`: late Chrome navigation events were rejected intentionally.
- `turn_seen_rejected`, `missing_candidate_stale_ignored`, or `stale_node_binding`: old DOM nodes are being rejected.
- `conversation_key_migrated`: a temporary `chatgpt:tab-*` key was rebound to an official `/c/...` conversation.

If the panel says `auto: paused`, click `Auto resume` for that chat after confirming the last 20 events. If a broken chat is causing churn, click `Auto off`, leave the chat, then click `Auto on` in a stable chat.

Important regression guard: content sends current page URL as `{ payload: { url } }`. `background/service-worker.js` must read `message.payload.url` through `getMessageUrl(message)` for `GET_CONTEXT`, `GET_STATUS`, and `CLEAR_AUTO_GUARD`. If this regresses to only `message.url`, normal chats can be falsely counted as path churn and auto-paused.

## Contract Check

| 항목 | 현재 기준 |
|---|---|
| 문서 기준 | `README.md`는 선택한 폴더를 저장 루트로 보고, 그 아래 `YYYY-MM/YYYY-MM-DD_HHMMSS__conversationId/turn_0000__timestamp__status.md` 구조를 예시로 둔다. |
| 실제 샘플 | 현재 repo 루트에 `2026-06/2026-06-26_062911__c-.../turn_0020__...__saved.md`, `missing/`, `variants/`가 존재한다. |
| 코드 가정 | `background/service-worker.js`의 `buildSnapshotPath()`가 월 폴더, conversation 폴더, 긴 turn 파일명을 생성한다. `content/content-script.js`는 사용자가 고른 File System Access 폴더를 그대로 루트로 사용한다. |
| 불일치 | 없음. 확장프로그램은 사용자가 고른 app/project root에 pending snapshot job을 만든다. |
| 처리 방향 | 확장프로그램 저장 루트는 `D:\_my_tools\ChatGPT_Snapshot`로 유지한다. 사람이 보는 archive/index/HTML은 별도 정리 스킬이 `D:\_my_tools\ChatGPT_Snapshot_Archive`에 생성한다. |

## Current Project State

- Chrome MV3 extension name: `ChatGPT Snapshot Keeper`.
- Current MVP version in `manifest.json`: `0.3.30`.
- Main files:
  - `background/service-worker.js`: state ledger, path creation, hash/variant/missing records, File System Access write request.
  - `content/content-script.js`: ChatGPT DOM detection, parser, floating bar, directory picker, relative file writing.
  - `content/floating-bar.css`: compact/expanded bar styling.
  - `options/`: extension options and privacy text.
- Runtime output folders such as `2026-*/` are expected pending job folders in this app/project root. They are ignored by `.gitignore` and should be removed from the active root only after the archive skill has copied/indexed them.

## Current Save Behavior

- User clicks `Set folder` in the Snapshot Keeper bar.
- The selected folder is used as the direct root. The extension does not add an extra wrapper folder.
- `background/service-worker.js` builds relative paths like:

```text
YYYY-MM/YYYY-MM-DD_HHMMSS__conversationId/turn_0000__YYYY-MM-DD_HHMMSS__saved.md
YYYY-MM/YYYY-MM-DD_HHMMSS__conversationId/missing/turn_0000__YYYY-MM-DD_HHMMSS__missing.md
YYYY-MM/YYYY-MM-DD_HHMMSS__conversationId/variants/turn_0000__hash__YYYY-MM-DD_HHMMSS__variant.md
YYYY-MM/YYYY-MM-DD_HHMMSS__conversationId/escape/turn_0000__hash__YYYY-MM-DD_HHMMSS__escape.md
```

- Frontmatter already carries the important metadata: `status`, `appVersion`, `scanMode`, `pathSchemaVersion`, `writer`, `conversationKey`, `conversationUrl`, `turn`, `detectedAt`, `rawHash`, `normalizedHash`, and `filePath`.
- File modified time should not be treated as capture time. Use `detectedAt`.

## Agreed Archive Direction

Preferred external archive root:

```text
D:\_my_tools\ChatGPT_Snapshot_Archive\
├── README.md
├── snapshots\
├── archive\
├── index\
├── tmp\
└── skills\
```

Rules:

- Root should show only the main folders and one `README.md`.
- Root `README.md` is the browsing entry point and should be updated, not recreated under another name.
- `archive/` stays flat. Handoff/archive notes go directly inside it.
- `index/_index__snapshot_archive.md` is the global search index.
- `tmp/` is for disposable helper outputs such as evidence packets, repo-side QA/review outputs, processed-source backups, and trash.
- Current moved QA/review output location: `D:\_my_tools\ChatGPT_Snapshot_Archive\tmp\extension_repo_qa`.
- `skills/` is for skill backup or unpacked skill copies.
- Source snapshots may be deeper and machine-friendly.
- For next external AI review, include or mention the source copy of the archive/indexing skill under `D:\_my_tools\ChatGPT_Snapshot_Archive\skills` when present.
- Codex sessions may need to inspect the external archive root, not only this source repository, because source snapshots and archive skill materials are intentionally kept outside the extension repo.
- Current guarded live mode keeps automatic capture enabled for normal chats and disables it per conversation when unstable DOM behavior crosses guard thresholds. The panel also exposes a persisted global `Auto off` / `Auto on` switch and an `Auto resume` action for clearing the current conversation quarantine.
- Floating bar static UI mode is still enabled: waiting-dot animation, watchdog remounting, and composer-anchor recalculation remain disabled to avoid UI flicker.
- `Rescan` quiet UI mode is enabled: intermediate save/missing/error notifications are suppressed during the scan and summarized once after completion.
- Conversation identity is sticky across transient ChatGPT URLs without `/c/...`; this prevents repeated `chatgpt:tab-*` temporary keys and repeated `conversation_key_migrated` events during Rescan.
- `GET_STATUS` / `GET_CONTEXT` read the content page's current `location.href` from the extension payload; if the tab moved to another `/c/...` route and `webNavigation` missed it, status refresh updates the tab context before displaying counts/latest state. Do not regress this into reading only top-level `message.url`, because content sends `{ payload: { url } }`.
- Once `content_context` or `status_context` has confirmed a `/c/...` route, late `webNavigation` updates pointing at a different conversation are ignored so the panel cannot revert to stale counts from the previous chat.
- Snapshot, missing, invalid, and turn-seen candidates captured under an old navigation epoch are rejected as `stale_node_binding` instead of being saved or counted.
- Content node bindings are refreshed before processing each candidate. If `TURN_SEEN` still returns `stale_node_binding`, the content script drops that cached binding and marks the current fingerprint processed to stop retry loops.
- When `visibleTurn < lastSeenTurn` for the same conversation, UI uses the visible turn for display/next-turn calculation and hides old latest/missing text so stored history cannot make the panel look stuck on an older `20 -> 30` state.
- After route changes, `visibleTurnSyncPending` blocks fallback to stored `lastSeenTurn` until the content script observes the current visible assistant turn. This prevents the temporary `20 -> 30` flash before live parsing catches up.
- Content UI must honor `displayTurn: 0` during sync. Do not use `status.displayTurn || status.lastSeenTurn`, because that revives stale `20 -> 10` style displays.
- `navigationEpoch` advances only when the resolved `conversationKey` changes. Path-only URL churn inside the same conversation must not reset `visibleTurn` or create repeated stale-binding loops.
- Live automatic inspection is globally user-toggleable and per-conversation guarded. A conversation is marked `autoCaptureDisabled` when path churn, stale bindings, or repeated live missing events cross thresholds. `GET_CONTEXT` returns status too, so content can stop immediately if the guard flips during binding.
- Live text stabilization no longer switches the compact bar into `waiting`; waiting UI is reserved for real save/message events so opening a chat does not flicker `ready -> waiting -> ready`.
- After a conversation key/epoch change, live automatic inspection waits `LIVE_ROUTE_SETTLE_MS` before trusting the first visible assistant candidate. This is meant to avoid transient stale visible nodes on broken ChatGPT pages.
- Live candidate selection uses assistant messages near the viewport, not only strictly intersecting the viewport, to avoid `SK ready` stalls on unusual ChatGPT layouts.
- Normal UI suppresses the `stored history` diagnostic when `visibleTurn < lastSeenTurn`; keep that detail in state/events, not in the user-facing panel.
- `Escape save` is a manual-only rescue path. It saves the latest loaded assistant message as `status: escape` under `escape/` when the model fails before a scheduled snapshot turn. It must not be treated as a normal `saved` snapshot.
- `Escape save` records are counted separately and are excluded from the normal `latest` status text to avoid a persistent `escape: save_confirmed` refresh flicker.

Preferred source snapshot shape for future cleanup/indexing:

```text
snapshots/YYYY-MM/YYYY-MM-DD__conversationId/
├── turn020_saved.md
├── turn060_missing.md
├── turn016_escape.md
└── variants/
```

Important: this shorter source filename rule is an archive cleanup/indexing preference. The extension code currently still writes the longer path schema.

## Known Design Decision

For routine future work, the user wants this to be a narrow repeated workflow, not a high-reasoning model task.

The desired split:

- Extension: save conservative snapshot source files only.
- Archive skill/session: move/index/summarize into the external archive structure.
- Handoff/archive notes: make the contents easy for the user and future GPT/Codex sessions to follow.

## Next Implementation Options

Option A: no extension code change.

- User selects `D:\_my_tools\ChatGPT_Snapshot` as the extension save folder.
- Extension continues producing its current long file paths under project-root month folders.
- Archive/indexing skill later copies, normalizes, indexes, and moves processed project-root pending folders out of the active root.
- This matches the current app workflow.

Option B: update extension path schema.

- Change `PATH_SCHEMA_VERSION`.
- Update `buildSnapshotPath()` to emit shorter file names such as `turn020_saved.md`.
- Keep date and conversation ID in the folder.
- Preserve all capture/system metadata in frontmatter.
- Update README save location section and QA expectations.
- Higher risk because existing state may contain `folderPath`, `filePath`, `previousFolderPaths`, and pending retry bodies.

## Red Zone / Safety Notes

- Do not save full user prompts.
- Do not save full assistant answers outside snapshot markers, except when the user explicitly clicks `Escape save`; that output must be marked `status: escape` and kept separate from normal `saved` snapshots.
- Do not store ChatGPT input box text.
- Do not reconstruct missing snapshot bodies.
- Do not treat `saved`, `missing`, or `variant` as content quality judgments.
- Do not force-scroll old conversation history.
- Do not move or delete existing runtime snapshots unless explicitly requested.
- Do not keep `_qa`, `__pycache__`, or generated review packages under `D:\_my_tools\ChatGPT_Snapshot`; Chrome's unpacked-extension loader rejects `_`-prefixed folders even if Git ignores them.
- Put future repo-side QA/review packages under `D:\_my_tools\ChatGPT_Snapshot_Archive\tmp\extension_repo_qa` or another external archive `tmp/` subfolder.
- Before changing path schema, compare:
  - README/documented path
  - actual sample output
  - `buildSnapshotPath()` and `folderPathMatchesConversationKey()` assumptions

## QA Pointers

Minimum manual QA after extension path or writer changes:

- Set folder through the floating bar.
- Confirm the normal panel exposes `Set folder`, `Rescan`, `Escape save`, `Auto off/on/resume`, and `Open archive`; retry, clear-error, and QA-save controls are developer-only message handlers.
- Confirm the normal panel count grid shows `escape` and `auto` instead of `folder`; clicking `Escape save` saves only the latest assistant message to `escape/` with `status: escape`.
- Toggle `Auto off`, reload the tab, and confirm live automatic capture stays off until `Auto on` is clicked. Force a per-chat auto pause and confirm the button becomes `Auto resume` and clears that conversation's quarantine.
- Use `Open archive` and confirm it targets the human-facing folder `D:\_my_tools\ChatGPT_Snapshot_Archive\archive`, not the raw `snapshots/YYYY-MM/...` evidence folder. It intentionally opens a Chrome file tab; folder-opening helpers must not interfere with snapshot saving.
- Generate a valid `SNAPSHOT_START` / `SNAPSHOT_END` turn and confirm saved markdown.
- Generate a valid snapshot turn, click `Rescan`, and confirm saved markdown.
- Use `Rescan` after a snapshot turn scrolls offscreen and confirm it scans loaded snapshot candidates, not only visible assistant messages.
- After a save error, confirm automatic loaded scans do not loop forever. `Rescan` should first ensure folder permission and then perform the user-triggered retry.
- Generate a missing snapshot turn and confirm `missing` record without original body and a distinct missing warning notice.
- Repeat a manual rescan for the same missing turn and confirm duplicate missing files are not created for the same reason/section set.
- Fix a previously missing turn and confirm it moves out of active `missingTurns` while keeping resolved-missing history.
- Generate `## turn=20` with `SNAPSHOT_START turn=10` and confirm it is `invalid_snapshot`, not `missing`.
- Omit the final Korea time line until retry limit and confirm `korea_time_missing_after_retry_limit` missing record.
- Rescan visible messages and confirm duplicate hashes are ignored.
- Trigger a variant by changing same turn snapshot content and confirm variant metadata.
- Check `chrome.storage.local` state counts: saved, missing, variant, latest file path.
- Reload ChatGPT tab after extension reload and confirm stale context message clears after refresh.

## Recent Bugfix Targets

The current bugfix pass keeps the existing feature set and only corrects state/notification accuracy:

- Missing save success now uses `MISSING_CONFIRMED` instead of `SAVE_CONFIRMED`.
- Missing records show a distinct warning/error notice.
- Repeated missing records for the same turn/reason/section set are de-duplicated in state.
- Later saved recovery removes that turn from active `missingTurns` and records resolved-missing history.
- Marker turn mismatch is treated as invalid.
- Korea time retry exhaustion creates a missing record instead of silently stopping.
- Loaded offscreen snapshot candidates are scanned by `Rescan` so a single-window `turn=10` can be recovered if it scrolled out of view but remains loaded in the DOM.
- Source-check and parse-retry failures for snapshot turns now produce a missing/error state instead of silent drop.
- Required-section detection rechecks the final extracted snapshot body, not only the first marker-scan block, so a completed snapshot can recover from an earlier `required_sections_missing` record.
- Repeated missing detections notify the tab again instead of looking like Rescan did nothing.
- Service worker debug logging defaults to off.

## Current Open Question

Whether to leave extension path schema as-is and rely on archive cleanup, or change extension output to the shorter archive-preferred filename pattern.

Conservative recommendation: start with Option A. Use the external archive root first, then only change extension path schema if the long names keep causing friction.
