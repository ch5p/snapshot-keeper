#!/usr/bin/env python3
"""Verify Snapshot Keeper archive sync completeness.

This is a deterministic guardrail for the conversation-snapshot-indexer skill.
It checks both archive-root coverage and project-root pending jobs so the skill
does not report completion while source snapshots remain unprocessed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


PROJECT_MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
GENERIC_RE = re.compile(
    r"단일 스냅샷 보관|단일 turn 보관|자세한 주제는 원문|세부 주제는 원문"
)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig", errors="replace")


def count_project_jobs(project_root: Path) -> tuple[int, int]:
    folders = 0
    files = 0
    if not project_root.exists():
        return folders, files
    for month_dir in project_root.iterdir():
        if not month_dir.is_dir() or not PROJECT_MONTH_RE.match(month_dir.name):
            continue
        for child in month_dir.iterdir():
            if child.is_dir():
                folders += 1
                files += sum(1 for p in child.rglob("*.md") if p.is_file())
    return folders, files


def main() -> int:
    parser = argparse.ArgumentParser(description="verify archive sync completeness")
    parser.add_argument("--archive-root", required=True)
    parser.add_argument("--project-root", required=True)
    args = parser.parse_args()

    archive_root = Path(args.archive_root)
    project_root = Path(args.project_root)
    archive_dir = archive_root / "archive"
    snapshots_dir = archive_root / "snapshots"
    archive_html_dir = archive_root / "archive_html"
    snapshot_html_dir = archive_root / "snapshot_html"
    index_path = archive_root / "index" / "_index__snapshot_archive.md"

    archive_notes = sorted(archive_dir.glob("*.md")) if archive_dir.exists() else []
    source_snapshots = sorted(snapshots_dir.rglob("*.md")) if snapshots_dir.exists() else []
    archive_html = sorted(archive_html_dir.glob("*.html")) if archive_html_dir.exists() else []
    snapshot_html = sorted(snapshot_html_dir.rglob("*.html")) if snapshot_html_dir.exists() else []
    project_job_folders, project_job_files = count_project_jobs(project_root)

    archive_text = "\n".join(read_text(path) for path in archive_notes)
    index_text = read_text(index_path) if index_path.exists() else ""
    uncovered_sources = []
    for source in source_snapshots:
        rel = source.relative_to(archive_root).as_posix()
        if rel not in archive_text:
            uncovered_sources.append(rel)

    missing_index_rows = []
    for note in archive_notes:
        if f"archive/{note.name}" not in index_text:
            missing_index_rows.append(note.name)

    missing_archive_html = [
        note.name for note in archive_notes
        if not (archive_html_dir / f"{note.stem}.html").exists()
    ]
    missing_snapshot_html = []
    for source in source_snapshots:
        rel = source.relative_to(snapshots_dir).as_posix()
        html_rel = rel[:-3] + ".html" if rel.lower().endswith(".md") else rel + ".html"
        if not (snapshot_html_dir / html_rel).exists():
            missing_snapshot_html.append(rel)

    generic_archive_matches = sum(
        1 for path in archive_notes if GENERIC_RE.search(read_text(path))
    )
    generic_html_matches = sum(
        1 for path in archive_html if GENERIC_RE.search(read_text(path))
    )

    result = {
        "project_jobs": project_job_folders,
        "project_job_files": project_job_files,
        "source_snapshots": len(source_snapshots),
        "archive_notes": len(archive_notes),
        "archive_html": len(archive_html),
        "snapshot_html": len(snapshot_html),
        "uncovered_sources": uncovered_sources,
        "missing_index_rows": missing_index_rows,
        "missing_archive_html": missing_archive_html,
        "missing_snapshot_html": missing_snapshot_html,
        "generic_archive_matches": generic_archive_matches,
        "generic_html_matches": generic_html_matches,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))

    failed = (
        project_job_folders
        or project_job_files
        or uncovered_sources
        or missing_index_rows
        or missing_archive_html
        or missing_snapshot_html
        or generic_archive_matches
        or generic_html_matches
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
