# Output Contract

Use this reference when producing final archive files or index rows.

## Archive root contract

Default root:

```text
D:\_my_tools\ChatGPT_Snapshot_Archive\
```

Expected root contents:

```text
README.md
snapshots\
archive\
index\
tmp\
```

Rules:

- The root should contain only the main folders and `README.md`.
- `README.md` is the browsing entry point and must be updated instead of recreated under another name.
- `README.md` should tell humans to start with `index/_index__snapshot_archive.md` when searching across archived notes.
- Source snapshots go under `snapshots/YYYY-MM/YYYY-MM-DD__conversationId/`.
- Source snapshot filenames use `turnNNN_status.md`.
- Handoff/archive notes go directly under `archive/`.
- The global index stays at `index/_index__snapshot_archive.md`.
- Root README archive entries must link to the corresponding `archive/*.md` note.
- Disposable helper outputs, evidence packets, processed-source backups, trash, and QA/review outputs go under `tmp/`.
- Do not create root-level `YYYY-MM` folders.
- Do not create `_README__archive.md` by default.
- `tmp/` may be absent until needed, but the root README should still define its role when present.

## Source input rules

Only treat markdown files as source snapshots when one of these is true:

- The file has YAML frontmatter with `status: saved`, `missing`, `variant`, `escape`, `invalid`, or `invalid_snapshot`.
- The file lives under `snapshots/` and its filename matches `turnNNN_status.md` or legacy `turn_NNNN__...__status.md`, including `escape` status files.

Ignore these by default unless the user explicitly asks to audit generated archive outputs:

- `README.md`
- `archive/*.md`
- `index/*.md`
- `tmp/*.md`

When a batch contains multiple `conversationKey` values, create one archive note per `conversationKey` unless the user explicitly asks for a combined batch. If `conversationKey` is missing, group by the nearest `snapshots/YYYY-MM/<conversation-folder>/` path.

Project-root pending jobs are part of the source contract. Before reporting completion, scan `D:\_my_tools\ChatGPT_Snapshot\YYYY-MM\*/` for pending conversation folders. If any exist, process them before reporting success, then move processed source folders under `tmp/processed_project_snapshots/`.

## Report contract

Every skill run report must include:

- source snapshot scan count
- project-root pending job count
- new/changed/uncovered documentization target count
- archive notes created/updated/unchanged
- HTML regeneration result
- verification result with `project_jobs=0`
- explicit no-op message when there is no new archive documentization target
- final link to the archive folder `D:\_my_tools\ChatGPT_Snapshot_Archive`, not directly to `index.html`

## Default archive note sections

1. `# <한글 제목>`
2. `원본 대화: [ChatGPT 대화](<conversationUrl>)` when `conversationUrl` exists
3. `## 선요약`
4. `## 검색 키워드`
5. `## 파일 범위`
6. `## 무엇에 관한 대화인가`
7. `## 확정된 내용`
8. `## 미확정/주의할 내용`
9. `## 제외된 주제`
10. `## 이어갈 때 필요한 정보`
11. `## 원문 근거 파일`

Do not add extra top-level or second-level headings unless the user explicitly asks.

The H1 title must describe the actual source topic. Generic titles are not allowed when source content exists, including `단일 스냅샷 보관`, `단일 turn 보관`, `Snapshot Keeper 단일 turn 보관`, `스냅샷 정리`, or titles that only describe capture mechanics.

The `## 파일 범위` table must include every source snapshot file exactly once.

Every archive note must include:

- source snapshot folder
- `conversationKey` when present
- clickable `conversationUrl` when present
- turn range
- status counts
- full relative source file references

For `saved` snapshots, archive notes must include the actual extracted section bullets. A single-turn note is not allowed to collapse into generic wording like "자세한 주제는 원문 확인 필요" when the source snapshot has parseable section content.

For `escape` snapshots, treat the body as a manual rescue checkpoint from the latest assistant message, not as a model-compliant Snapshot Keeper block. Use it as evidence of the degraded handoff state, label it explicitly, and do not promote it to confirmed snapshot status unless later `saved` snapshots confirm the same content.

## Conservative wording

Use these labels instead of guessing:

- `스냅샷 근거 없음`
- `불명확`
- `확인 필요`
- `사용자 제공으로만 확인됨`
- `후속 스냅샷에서 확인 필요`

## Index row format

```markdown
| YYYY-MM-DD | turn010-070 | `filename.md` | 1문장 선요약 | 키워드1, 키워드2, 키워드3 | saved n / missing n / variant n / escape n / invalid n |
```

Omit zero statuses only when the remaining status text is unambiguous.

## Filename examples

```text
2026-06-26_turn010-070_스냅샷키퍼_로컬저장QA_missing_variant_병렬탭.md
2026-06-26_turn020-060_챗GPT스냅샷_핸드오프검증_index_anytxt.md
```
