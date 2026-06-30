#!/usr/bin/env python3
"""Build a conservative evidence packet from Snapshot Keeper markdown files.

This script does not summarize creatively. It extracts metadata, snapshot sections,
and source file paths, then writes evidence_packet.md and archive_seed.json.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

SECTION_NAMES = [
    "현재 진행 중인 주제",
    "새로 확정된 사항",
    "미확정 사항",
    "제외된 주제",
    "앞으로 할 일",
]

STATUS_WORDS = {"saved", "missing", "variant", "escape", "invalid"}
SOURCE_STATUS_WORDS = {"saved", "missing", "variant", "escape", "invalid", "invalid_snapshot"}
SOURCE_FILENAME_RE = re.compile(r"^turn[_-]?\d+(?:__|_).*(?:saved|missing|variant|escape|invalid).*\.md$", flags=re.I)
SECTION_ALIASES = {
    "제외된 주제": [
        "제외된 주제 (1회 기록)",
    ],
}


@dataclass
class SnapshotRecord:
    source_path: str
    filename: str
    status: str
    turn: int | None
    detected_at: str | None
    reason: str | None
    conversation_key: str | None
    conversation_url: str | None
    file_path: str | None
    raw_hash: str | None
    normalized_hash: str | None
    sections: Dict[str, List[str]]
    body_excerpt: str


def iter_markdown_files(paths: Iterable[str]) -> List[Path]:
    files: List[Path] = []
    for raw in paths:
        path = Path(raw).expanduser().resolve()
        if path.is_dir():
            files.extend(sorted(path.rglob("*.md")))
        elif path.is_file() and path.suffix.lower() == ".md":
            files.append(path)
    seen = set()
    unique = []
    for file in files:
        if file not in seen:
            seen.add(file)
            unique.append(file)
    return unique


def is_source_snapshot_file(path: Path) -> bool:
    name = path.name.lower()
    if name in {"readme.md", "_index__snapshot_archive.md"}:
        return False
    parts = {part.lower() for part in path.parts}
    if "archive" in parts or "index" in parts or "work" in parts or "maintenance" in parts or "tmp" in parts:
        return False
    if SOURCE_FILENAME_RE.match(path.name):
        return True
    try:
        text = path.read_text(encoding="utf-8-sig", errors="replace")
    except Exception:
        return False
    meta, _body = parse_frontmatter(text)
    return (meta.get("status") or "").strip().lower() in SOURCE_STATUS_WORDS


def parse_frontmatter(text: str) -> Tuple[Dict[str, str], str]:
    text = text.lstrip("\ufeff")
    if not text.startswith("---"):
        return {}, text
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, flags=re.S)
    if not match:
        return {}, text
    fm_text = match.group(1)
    body = text[match.end():]
    meta: Dict[str, str] = {}
    current_key = None
    for line in fm_text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*:\s*", line):
            key, value = line.split(":", 1)
            value = value.strip().strip('"').strip("'")
            meta[key.strip()] = value
            current_key = key.strip()
        elif current_key and line.strip().startswith("-"):
            meta[current_key] = (meta.get(current_key, "") + " " + line.strip()).strip()
    return meta, body


def parse_turn(meta: Dict[str, str], filename: str) -> int | None:
    for key in ("turn", "markerTurn"):
        value = meta.get(key)
        if value and re.search(r"\d+", value):
            return int(re.search(r"\d+", value).group(0))
    match = re.search(r"turn[_=-]?(\d+)", filename, flags=re.I)
    if match:
        return int(match.group(1))
    return None


def parse_status(meta: Dict[str, str], filename: str) -> str:
    status = (meta.get("status") or "").strip().lower()
    if status:
        return status
    lowered = filename.lower()
    for word in STATUS_WORDS:
        if word in lowered:
            return word
    return "unknown"


def parse_sections(body: str) -> Dict[str, List[str]]:
    sections: Dict[str, List[str]] = {}
    matches = list(re.finditer(r"^###\s+(.+?)\s*$", body, flags=re.M))
    for idx, match in enumerate(matches):
        title = canonical_section_name(match.group(1))
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(body)
        content = body[start:end].strip()
        items = []
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("-"):
                items.append(stripped)
        if not items and content:
            items = [content]
        sections[title] = items
    return sections


def normalize_section_name(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lstrip("#").strip().rstrip(":")).casefold()


def canonical_section_name(title: str) -> str:
    normalized = normalize_section_name(title)
    for canonical in SECTION_NAMES:
        names = [canonical, *SECTION_ALIASES.get(canonical, [])]
        if normalized in {normalize_section_name(name) for name in names}:
            return canonical
    return title.strip()


def clean_excerpt(body: str, limit: int = 500) -> str:
    body = re.sub(r"\n{3,}", "\n\n", body.strip())
    if len(body) <= limit:
        return body
    return body[:limit].rstrip() + "..."


def parse_snapshot(path: Path) -> SnapshotRecord:
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    meta, body = parse_frontmatter(text)
    return SnapshotRecord(
        source_path=str(path),
        filename=path.name,
        status=parse_status(meta, path.name),
        turn=parse_turn(meta, path.name),
        detected_at=meta.get("detectedAt"),
        reason=meta.get("reason"),
        conversation_key=meta.get("conversationKey"),
        conversation_url=meta.get("conversationUrl"),
        file_path=meta.get("filePath"),
        raw_hash=meta.get("rawHash"),
        normalized_hash=meta.get("normalizedHash"),
        sections=parse_sections(body),
        body_excerpt=clean_excerpt(body),
    )


def sort_key(record: SnapshotRecord) -> Tuple[int, str]:
    return (record.turn if record.turn is not None else 10**9, record.filename)


def conversation_group_key(record: SnapshotRecord) -> str:
    if record.conversation_key:
        return record.conversation_key
    path = Path(record.source_path)
    for part in reversed(path.parts[:-1]):
        if "__c-" in part or part.startswith("c-"):
            return part
    return str(path.parent)


def render_evidence_packet(records: List[SnapshotRecord]) -> str:
    records = sorted(records, key=sort_key)
    status_counts = Counter(record.status for record in records)
    turns = [record.turn for record in records if record.turn is not None]
    turn_range = f"turn{min(turns):03d}-turn{max(turns):03d}" if turns else "turn range unknown"

    lines: List[str] = []
    lines.append("# Snapshot Evidence Packet")
    lines.append("")
    lines.append("This packet is extracted evidence only. Do not infer missing conversation content from it.")
    lines.append("")
    lines.append("## Batch Overview")
    lines.append(f"- files: {len(records)}")
    lines.append(f"- turn_range: {turn_range}")
    lines.append("- status_counts: " + ", ".join(f"{k} {v}" for k, v in sorted(status_counts.items())))
    lines.append("")
    lines.append("## File Table")
    lines.append("| turn | status | detectedAt | reason | filename |")
    lines.append("|---:|---|---|---|---|")
    for r in records:
        lines.append(
            f"| {r.turn if r.turn is not None else ''} | {r.status} | {r.detected_at or ''} | {r.reason or ''} | `{r.filename}` |"
        )
    lines.append("")

    for r in records:
        lines.append(f"## turn={r.turn if r.turn is not None else 'unknown'} status={r.status}")
        lines.append(f"- source: `{r.source_path}`")
        if r.file_path:
            lines.append(f"- filePath: `{r.file_path}`")
        if r.reason:
            lines.append(f"- reason: {r.reason}")
        if r.raw_hash or r.normalized_hash:
            lines.append(f"- rawHash: `{r.raw_hash or ''}`")
            lines.append(f"- normalizedHash: `{r.normalized_hash or ''}`")
        if r.sections:
            for section in SECTION_NAMES:
                if section in r.sections:
                    lines.append(f"### {section}")
                    for item in r.sections[section]:
                        lines.append(item)
        else:
            lines.append("### extracted_body_excerpt")
            lines.append(r.body_excerpt or "(empty)")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_grouped_evidence_packet(groups: Dict[str, List[SnapshotRecord]]) -> str:
    lines: List[str] = []
    lines.append("# Snapshot Evidence Packet")
    lines.append("")
    lines.append("This packet is extracted evidence only. Do not infer missing conversation content from it.")
    lines.append("")
    for group_key in sorted(groups):
        lines.append(f"## Conversation Group: {group_key}")
        lines.append("")
        group_packet = render_evidence_packet(groups[group_key]).splitlines()
        start = group_packet.index("## Batch Overview") if "## Batch Overview" in group_packet else 0
        lines.extend(group_packet[start:])
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="build evidence packet from snapshot markdown files")
    parser.add_argument("paths", nargs="+", help="snapshot markdown files or directories")
    parser.add_argument("--out", default="snapshot_packet", help="output directory")
    args = parser.parse_args()

    files = iter_markdown_files(args.paths)
    if not files:
        raise SystemExit("no markdown files found")

    files = [path for path in files if is_source_snapshot_file(path)]
    if not files:
        raise SystemExit("no source snapshot markdown files found")

    records = [parse_snapshot(path) for path in files]
    records.sort(key=sort_key)

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    groups: Dict[str, List[SnapshotRecord]] = {}
    for record in records:
        groups.setdefault(conversation_group_key(record), []).append(record)

    packet = render_evidence_packet(records) if len(groups) == 1 else render_grouped_evidence_packet(groups)
    (out_dir / "evidence_packet.md").write_text(packet, encoding="utf-8")
    (out_dir / "archive_seed.json").write_text(
        json.dumps([asdict(record) for record in records], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"wrote {out_dir / 'evidence_packet.md'}")
    print(f"wrote {out_dir / 'archive_seed.json'}")


if __name__ == "__main__":
    main()
