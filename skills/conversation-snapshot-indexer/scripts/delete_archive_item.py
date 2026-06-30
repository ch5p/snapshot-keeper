#!/usr/bin/env python3
"""Move one archive item and its generated/source files to tmp/trash.

This script is intentionally conservative:
- dry-run by default
- refuses paths outside the archive root
- moves files to tmp/trash instead of deleting permanently
- regenerates HTML and verifies archive sync after confirmed moves
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path


SOURCE_RE = re.compile(r"`?(snapshots/[^\s`]+?\.md)`?")
INDEX_ROW_RE = re.compile(r"^\|.*?archive/([^`|]+\.md).*?\|\s*$")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig", errors="replace")


def write_bom(path: Path, text: str) -> None:
    path.write_text("\ufeff" + text.lstrip("\ufeff"), encoding="utf-8")


def safe_child(root: Path, path: Path) -> Path:
    resolved_root = root.resolve()
    resolved = path.resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise SystemExit(f"refusing path outside archive root: {resolved}")
    return resolved


def unique_target(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    parent = path.parent
    index = 2
    while True:
        candidate = parent / f"{stem}_{index}{suffix}"
        if not candidate.exists():
            return candidate
        index += 1


def move_to_trash(path: Path, archive_root: Path, trash_root: Path, moved: list[str]) -> None:
    if not path.exists():
        return
    safe_child(archive_root, path)
    rel = path.resolve().relative_to(archive_root.resolve())
    target = unique_target(trash_root / rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(target))
    moved.append(str(rel).replace("\\", "/"))


def remove_index_row(index_path: Path, note_name: str, archive_root: Path, trash_root: Path, moved: list[str], dry_run: bool) -> bool:
    if not index_path.exists():
        return False
    text = read_text(index_path)
    lines = text.splitlines()
    kept = []
    removed = []
    for line in lines:
        match = INDEX_ROW_RE.match(line)
        if match and match.group(1) == note_name:
            removed.append(line)
        else:
            kept.append(line)
    if not removed:
        return False
    if not dry_run:
        backup = trash_root / "index" / (index_path.name + ".before_delete")
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_text(text, encoding="utf-8")
        moved.append(str(backup.relative_to(trash_root)).replace("\\", "/"))
        write_bom(index_path, "\n".join(kept).rstrip() + "\n")
    return True


def run_python(script: Path, args: list[str]) -> None:
    subprocess.run([sys.executable, str(script), *args], check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="trash one archive item and regenerate archive HTML")
    parser.add_argument("--archive-root", required=True)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--note", required=True, help="archive note filename, e.g. 2026-...md")
    parser.add_argument("--confirm", action="store_true", help="actually move files to tmp/trash")
    parser.add_argument("--no-render", action="store_true", help="skip render/verify after confirmed move")
    args = parser.parse_args()

    archive_root = Path(args.archive_root)
    project_root = Path(args.project_root)
    note_name = Path(args.note).name
    note_path = safe_child(archive_root, archive_root / "archive" / note_name)
    if not note_path.exists():
        raise SystemExit(f"archive note not found: {note_path}")

    note_text = read_text(note_path)
    source_rels = sorted(set(SOURCE_RE.findall(note_text)))
    html_path = archive_root / "archive_html" / (note_path.stem + ".html")
    source_paths = [archive_root / rel for rel in source_rels]
    snapshot_html_paths = []
    for rel in source_rels:
        snap_rel = rel[len("snapshots/"):]
        snapshot_html_paths.append(archive_root / "snapshot_html" / (snap_rel[:-3] + ".html"))

    targets = [note_path, html_path, *source_paths, *snapshot_html_paths]
    index_path = archive_root / "index" / "_index__snapshot_archive.md"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    trash_root = archive_root / "tmp" / "trash" / f"{timestamp}_{note_path.stem}"

    plan = {
        "note": note_name,
        "confirm": bool(args.confirm),
        "trash_root": str(trash_root),
        "files_to_move": [
            str(path.relative_to(archive_root)).replace("\\", "/")
            for path in targets if path.exists()
        ],
        "index_row_remove": index_path.exists() and note_name in read_text(index_path),
    }
    print(json.dumps(plan, ensure_ascii=False, indent=2))

    if not args.confirm:
        print("dry-run only; rerun with --confirm to move files to tmp/trash")
        return 0

    moved: list[str] = []
    for target in targets:
        move_to_trash(target, archive_root, trash_root, moved)
    remove_index_row(index_path, note_name, archive_root, trash_root, moved, dry_run=False)

    log_path = trash_root / "delete_log.json"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(
        json.dumps({"plan": plan, "moved": moved}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    if not args.no_render:
        script_dir = Path(__file__).resolve().parent
        run_python(script_dir / "render_archive_html.py", ["--archive-root", str(archive_root)])
        run_python(
            script_dir / "verify_archive_sync.py",
            ["--archive-root", str(archive_root), "--project-root", str(project_root)],
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
