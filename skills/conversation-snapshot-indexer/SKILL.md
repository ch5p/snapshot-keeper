---
name: conversation-snapshot-indexer
description: conservative incremental local-search archive indexing for Snapshot Keeper markdown exports and long ChatGPT conversation snapshots. use when the user says to use the skill, asks to collect unarchived snapshots, update an existing archive/index, process saved/missing/variant snapshot .md files, or create Korean filenames, short summaries, searchable keyword blocks, turn/status tables, index rows, or handoff notes without creative writing, guessing, or filling gaps between snapshots.
---

# Conversation Snapshot Indexer

## Purpose

Turn Snapshot Keeper markdown snapshots into local-search-friendly Korean archive notes. Prioritize findability, factual continuity, and reuse over pretty prose.

Default to Korean output unless the user asks otherwise. Assume the archive is for the user's future local search with tools such as anytxt, plain text search, or markdown search.

## Archive Workspace Layout

Use this archive root unless the user provides another path:
`D:\_my_tools\ChatGPT_Snapshot_Archive`

Root-level structure:

```text
ChatGPT_Snapshot_Archive\
├── README.md
├── snapshots\
├── archive\
├── index\
└── tmp\
```

Root rules:

- Keep the archive root easy to scan. It should show only the main folders and one `README.md` file.
- Do not create root-level month folders such as `2026-06`.
- Do not create extra root summary files. Update the root `README.md` instead.
- Do not put runtime snapshot outputs directly inside a source-code repository root.
- `snapshots/` may be deep and machine-friendly because it stores source evidence.
- `archive/` must stay flat because it is the human-facing handoff folder.
- `index/` stores global search indexes only.
- `tmp/` stores disposable helper outputs such as evidence packets, processed-source backups, QA/review packages, and trash.
- Never create `_qa`, `__pycache__`, review zip files, or temporary evidence folders under `D:\_my_tools\ChatGPT_Snapshot`; Chrome Load unpacked may reject `_`-prefixed folders in the extension root.
- Put repo-side QA/review outputs under `D:\_my_tools\ChatGPT_Snapshot_Archive\tmp\extension_repo_qa` unless the user provides another external temp folder.

Snapshot source layout:

```text
snapshots/YYYY-MM/YYYY-MM-DD__conversationId/
```

Source snapshot filenames should be short and stable:

```text
turnNNN_status.md
```

Examples: `turn020_saved.md`, `turn060_missing.md`, `turn070_variant.md`.

Filename rules:

- Use three-digit turn numbers when practical: `turn020`, `turn100`.
- Put the date and conversation ID in the folder name, not each source filename.
- Keep capture time, URL, hash, and system metadata in markdown frontmatter, not in filenames.
- Do not trust filesystem modified time as capture time. Use `detectedAt` from frontmatter.

Human-facing outputs:

- Put handoff/archive notes directly under `archive/`; do not make `archive/YYYY-MM/` unless the user explicitly asks.
- Keep the global index at `index/_index__snapshot_archive.md`.
- Update root `README.md` as the entry point for browsing the archive.
- Link README archive entries to the corresponding `archive/*.md` note with relative Markdown links.
- Put a clickable original ChatGPT conversation link directly below the archive note title when `conversationUrl` is present in source frontmatter.
- Do not create `_README__archive.md` inside `archive/` by default.

## Default Incremental Behavior

When the user simply says "use the skill", "스킬 사용", "취합해", or similar without extra instructions:

1. Use `D:\_my_tools\ChatGPT_Snapshot_Archive` as the archive root.
2. Scan both source locations:
   - project-root pending jobs: `D:\_my_tools\ChatGPT_Snapshot\YYYY-MM\<conversation-folder>\**\*.md`
   - archived evidence: `D:\_my_tools\ChatGPT_Snapshot_Archive\snapshots\YYYY-MM\<conversation-folder>\*.md`
3. Read the current `index/_index__snapshot_archive.md` and existing files under `archive/`.
4. Treat snapshots already represented by an archive note/index row as already collected.
5. Collect snapshots that are new, not covered by an index row, newer than the relevant archive note, or still sitting in the project-root pending job folder.
6. If new snapshots extend an existing conversation archive, update that archive note and its index row instead of creating a duplicate note.
7. If a new `conversationKey` appears, create one new archive note for that conversation and add one index row.
8. Copy project-root pending job snapshots into archive `snapshots/` using the short `turnNNN_status.md` style, then move processed project-root month folders under `tmp/processed_project_snapshots/`.
9. Write temporary packets only under `tmp/`, preferably `tmp/snapshot_packet` or `tmp/extension_repo_qa`.
10. Update the root `README.md` only when navigation, stored archive items, or visible folder roles change.
11. Run verification and do not report completion unless `project_jobs` is `0`, every archive note has index/HTML coverage, and every archived source snapshot has `snapshot_html` coverage.

Do not require the user to repeat the archive root or folder policy unless the local files contradict these rules.

## Reporting

Keep user-facing reports short, but always include the source-to-archive decision:

- `원본 스캔`: how many `snapshots/**/*.md` files were found.
- `대기 원본`: how many project-root pending conversation folders and files were found.
- `문서화 대상`: how many source snapshots or conversation groups were new, changed, uncovered, or still pending in the project root.
- `archive 반영`: archive notes created, updated, or unchanged.
- `HTML 반영`: whether `index.html`, `archive_html`, and `snapshot_html` were regenerated.
- `완료 검증`: include `project_jobs=0`, archive note count, archive HTML count, source snapshot count, and snapshot HTML count.
- If `문서화 대상` is 0, say explicitly: `새로 archive 문서화할 원본은 없었습니다.`
- End the final report with a link to the archive folder `D:\_my_tools\ChatGPT_Snapshot_Archive`, not directly to `index.html`, so the user can open it in Explorer and choose the file.

## HTML Rendering (Deterministic, Auto-Generated)

The browsing layer (`index.html`, `archive_html/*.html`) and the README "현재 보관 항목" list are generated, never hand-written.

- Do not write or edit HTML by hand. Do not hand-edit the `## 현재 보관 항목` section.
- After creating or updating any `archive/*.md` note, run:

```bash
python scripts/render_archive_html.py --archive-root "D:\_my_tools\ChatGPT_Snapshot_Archive"
```

- Then run:

```bash
python scripts/verify_archive_sync.py --archive-root "D:\_my_tools\ChatGPT_Snapshot_Archive" --project-root "D:\_my_tools\ChatGPT_Snapshot"
```

- If verification reports `project_jobs` greater than `0`, the skill is not complete. Process those pending source folders first.

- This reads `archive/*.md` and regenerates, deterministically:
  - `index.html` (search + cards, OpenAI-style dark theme)
  - `archive_html/<same-name>.html` (one page per note, with a back-to-index link and a direct "원본 ChatGPT 대화 열기" button)
  - the `## 현재 보관 항목` section of `README.md`
- `index.html` includes a per-card delete-command copy button. The copied command runs `delete_archive_item.py`, which moves the note, generated HTML, referenced source snapshots, and snapshot HTML into `tmp/trash`, updates the index, rerenders HTML, and verifies sync.
- The script is pure standard library (no pip installs) and safe to re-run; it only rewrites generated files and that one README section.
- Markdown stays the single source of truth. Fix content in `archive/*.md`, then re-run the script. Never patch the HTML to fix content.

## Hard Rules

- Do not invent missing conversation content.
- Do not infer causes unless the snapshot text explicitly supports the cause.
- Do not fill gaps between turns.
- Do not treat a single-turn `saved` snapshot as empty. If a saved snapshot has section bullets, promote those bullets into the archive note instead of writing generic phrases such as "원문 확인 필요".
- Do not produce creative prose, diary-style writing, nostalgia, jokes, or narrative reconstruction unless the user explicitly asks for that mode.
- Treat `saved`, `missing`, `variant`, and `escape` as capture statuses, not proof of conversation quality.
- Sort snapshots by `turn` first. Use `detectedAt` only as capture metadata.
- Preserve uncertainty. Use `불명확`, `확인 필요`, or `스냅샷 근거 없음` rather than guessing.
- Make output easy for low-capability models to follow: use fixed sections, short sentences, tables, and repeated search keywords.
- Keep Korean filenames practical and searchable. Do not make poetic titles.
- Do not use generic archive titles such as `단일 스냅샷 보관`, `단일 turn 보관`, `Snapshot Keeper 단일 turn 보관`, or `스냅샷 정리` when source content is available. The H1 title must name the actual subject from the snapshot, such as the project, tool, product, or decision topic.

## Snapshot Interpretation

Interpret labels together with their section names:

- `새로 확정된 사항` + `[확인됨]`: treat as confirmed or decided content from that snapshot.
- `현재 진행 중인 주제` + `[확인됨]`: treat as the current working context at that turn.
- `앞으로 할 일` + `[확인됨]`: treat as a committed next action, not completed work.
- `미확정 사항`: treat every item as unresolved unless a later snapshot confirms it.
- `제외된 주제`: treat as intentionally out of scope unless a later snapshot explicitly reverses it.
- `missing` snapshot: record the capture failure reason. Do not reconstruct the missing body.
- `variant` snapshot: record that a variant exists. Do not call it an error unless the metadata or text says so.
- `escape` snapshot: record that the user manually rescued the latest assistant message before a scheduled snapshot turn. Do not treat it as a normal compliant snapshot, but include its explicit text as available evidence.
- For a one-file `saved` snapshot, the archive note must still include the actual bullets from `현재 진행 중인 주제`, `새로 확정된 사항`, `미확정 사항`, `제외된 주제`, and `앞으로 할 일` when present.
- Use "원문 확인 필요" only when the source body is missing, unparsable, or actually has no relevant section content.

## Standard Workflow

1. Collect all uploaded or provided `.md` snapshot files.
2. If files are available in the local runtime, run:

```bash
python scripts/snapshot_packet.py --out "D:\_my_tools\ChatGPT_Snapshot_Archive\tmp\snapshot_packet" <snapshot-files-or-directory>
```

3. Read the generated `evidence_packet.md` before writing the archive note.
4. Create the outputs requested by the user. If unspecified, create:
   - one Korean archive note for the conversation or snapshot batch, saved directly under `archive/`
   - one index row suitable for `index/_index__snapshot_archive.md`
   - one root `README.md` update when archive contents or navigation change
5. Keep all summaries grounded in the evidence packet and source snapshots.

## Default Output Set

### 1. Korean archive note

Use a filename like:

```text
YYYY-MM-DD_turn010-070_핵심주제_검색키워드.md
```

Filename rules:

- Use Korean for the main topic.
- Keep it under about 90 characters when possible.
- Include the date if present.
- Include the turn range.
- Include 2 to 4 practical keywords.
- Avoid emojis, decorative punctuation, and vague titles such as `정리`, `대화`, `기록` alone.
- Match the archive note H1 to the actual source topic. Do not let the turn count, status, or Snapshot Keeper mechanism become the title unless the conversation is actually about Snapshot Keeper.

### 2. Index row

Appendable markdown table row:

```markdown
| 날짜 | turn 범위 | 파일명 | 선요약 | 검색 키워드 | 상태 |
|---|---|---|---|---|---|
```

If the table header already exists, output only the row.

## Archive Note Template

Use this exact section order unless the user asks for a different format:

```markdown
# <한글 제목>

원본 대화: [ChatGPT 대화](<conversationUrl>)

## 선요약
<1-3문장. 어떤 대화인지 바로 알 수 있게 쓴다.>

## 검색 키워드
<한글과 원문 기술어를 함께 넣는다. 쉼표로 구분한다.>

## 파일 범위
| turn | status | detectedAt | 메모 |
|---:|---|---|---|

## 무엇에 관한 대화인가
<스냅샷에 실제로 있는 내용만 사용해 짧게 정리한다.>

## 확정된 내용
- <확정 또는 결정된 내용만>

## 미확정/주의할 내용
- <확인 필요, 불명확, missing, variant, 추정 항목>

## 제외된 주제
- <대화에서 제외 또는 보류된 주제>

## 이어갈 때 필요한 정보
- <다음에 이어서 작업할 때 필요한 최소 정보>

## 원문 근거 파일
- <파일명 또는 경로>
```

## Keyword Rules

Include search terms that the future user may actually type. Prefer both Korean and technical terms.

Examples:

- `스냅샷키퍼`, `snapshot keeper`
- `크롬 확장`, `chrome extension`
- `파일시스템액세스`, `file system access`, `showDirectoryPicker`
- `missing`, `variant`, `saved`
- `병렬 탭`, `재스캔`, `handoff`, `index`, `anytxt`

Do not remove technical words just to make prose smoother.

## Handoff Mode

When the user asks to continue an old conversation, create a conservative handoff instead of an archive note. Include:

- current topic
- confirmed decisions
- unresolved items
- excluded topics
- next actions
- source snapshot range

Do not write as if you personally remember the old conversation. Say the content comes from provided snapshots.

## QA Mode

When the user asks whether snapshots preserve context well, audit:

- turn continuity
- saved/missing/variant distribution
- whether the main project state can be reconstructed
- whether unresolved items remain distinguishable
- whether filenames and keywords are searchable
- whether any section labels are ambiguous

Rate practical usefulness for local search and conversation continuation separately.
