#!/usr/bin/env python3
"""
multi-edit-file.py — Atomic multi-file editor with WAL/journal rollback.

Reads JSON from stdin with the shape:
{
  "edits": [
    {
      "path": "/absolute/path/to/file",
      "operations": [
        { "type": "str_replace", "old_string": "...", "new_string": "..." },
        { "type": "insert", "line": 42, "text": "..." },
        { "type": "delete_lines", "start": 10, "end": 15 }
      ]
    }
  ],
  "dry_run": false
}

Operations are applied bottom-to-top within each file to avoid line drift.
Cross-file edits are atomic: if any file fails, all are rolled back.

Output JSON:
{
  "success": true,
  "files_modified": 2,
  "dry_run": false,
  "results": [
    {
      "path": "/abs/path",
      "operations_applied": 3,
      "diff": "unified diff string",
      "old_content": "...",
      "new_content": "...",
      "lines_before": 100,
      "lines_after": 105,
      "bytes_before": 2048,
      "bytes_after": 2200
    }
  ]
}
"""

import json
import os
import sys
import stat
import difflib
import tempfile
import shutil


def error_exit(msg):
    print(json.dumps({"success": False, "error": msg}))
    sys.exit(0)


def read_file(path):
    """Read file content, return string."""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write_file(path, content, mode=None):
    """Write content to file, optionally preserving permissions."""
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    if mode is not None:
        os.chmod(path, mode)


def get_file_mode(path):
    """Get file permission mode."""
    return stat.S_IMODE(os.stat(path).st_mode)


def detect_language(path):
    """Detect language from file extension for syntax highlighting."""
    ext_map = {
        ".py": "python", ".js": "javascript", ".ts": "typescript",
        ".tsx": "tsx", ".jsx": "jsx", ".rb": "ruby", ".go": "go",
        ".rs": "rust", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
        ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
        ".cs": "csharp", ".swift": "swift", ".sh": "bash", ".bash": "bash",
        ".zsh": "bash", ".fish": "fish", ".json": "json", ".yaml": "yaml",
        ".yml": "yaml", ".toml": "toml", ".xml": "xml", ".html": "html",
        ".css": "css", ".scss": "scss", ".less": "less", ".sql": "sql",
        ".md": "markdown", ".clj": "clojure", ".cljs": "clojure",
        ".cljc": "clojure", ".edn": "clojure", ".ex": "elixir",
        ".exs": "elixir", ".erl": "erlang", ".hs": "haskell",
        ".lua": "lua", ".r": "r", ".R": "r", ".pl": "perl",
        ".php": "php", ".tf": "hcl", ".proto": "protobuf",
        ".graphql": "graphql", ".gql": "graphql", ".vim": "vim",
        ".dockerfile": "dockerfile", ".Dockerfile": "dockerfile",
        ".ini": "ini", ".cfg": "ini", ".conf": "ini",
    }
    _, ext = os.path.splitext(path)
    basename = os.path.basename(path).lower()
    if basename == "dockerfile":
        return "dockerfile"
    if basename == "makefile":
        return "makefile"
    return ext_map.get(ext, "text")


def apply_str_replace(content, op):
    """Apply str_replace operation. Returns new content."""
    old_str = op["old_string"]
    new_str = op.get("new_string", "")

    if old_str not in content:
        raise ValueError(f"String to replace not found in file")

    count = content.count(old_str)
    if count > 1:
        raise ValueError(
            f"old_string matches {count} locations. "
            f"Provide more context to make it unique."
        )

    return content.replace(old_str, new_str, 1)


def apply_insert(content, op):
    """Apply insert operation at a specific line. Returns new content."""
    line_num = op["line"]
    text = op["text"]
    lines = content.split("\n")

    if line_num < 0 or line_num > len(lines):
        raise ValueError(
            f"Line number {line_num} out of range (0-{len(lines)})"
        )

    # Insert after the specified line (0 = beginning of file)
    if not text.endswith("\n"):
        text += "\n"

    insert_lines = text.split("\n")
    # Remove trailing empty from split
    if insert_lines and insert_lines[-1] == "":
        insert_lines = insert_lines[:-1]

    lines[line_num:line_num] = insert_lines
    return "\n".join(lines)


def apply_delete_lines(content, op):
    """Apply delete_lines operation. Returns new content."""
    start = op["start"]  # 1-indexed inclusive
    end = op["end"]  # 1-indexed inclusive
    lines = content.split("\n")

    if start < 1 or end < start or end > len(lines):
        raise ValueError(
            f"Line range {start}-{end} out of range (1-{len(lines)})"
        )

    # Convert to 0-indexed
    del lines[start - 1 : end]
    return "\n".join(lines)


def apply_operations(content, operations):
    """Apply operations bottom-to-top to avoid line drift.
    str_replace doesn't need reordering (string-based).
    insert and delete_lines are reordered by line number descending.
    """
    # Separate string-based ops from line-based ops
    str_ops = [op for op in operations if op["type"] == "str_replace"]
    line_ops = [op for op in operations if op["type"] in ("insert", "delete_lines")]

    # Sort line-based ops by line number descending (bottom-to-top)
    def sort_key(op):
        if op["type"] == "insert":
            return op["line"]
        elif op["type"] == "delete_lines":
            return op["start"]
        return 0

    line_ops.sort(key=sort_key, reverse=True)

    # Apply line-based ops first (bottom-to-top), then str_replace
    for op in line_ops:
        if op["type"] == "insert":
            content = apply_insert(content, op)
        elif op["type"] == "delete_lines":
            content = apply_delete_lines(content, op)

    for op in str_ops:
        content = apply_str_replace(content, op)

    return content


def generate_diff(old_content, new_content, path):
    """Generate unified diff string."""
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    diff = difflib.unified_diff(
        old_lines, new_lines,
        fromfile=f"a/{os.path.basename(path)}",
        tofile=f"b/{os.path.basename(path)}",
        lineterm=""
    )
    return "\n".join(diff)


def main():
    # Read JSON from stdin
    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        error_exit(f"Invalid JSON input: {e}")

    edits = data.get("edits", [])
    dry_run = data.get("dry_run", False)
    show_diff = data.get("show_diff", False)

    if not edits:
        error_exit("No edits provided")

    # Validate all files exist first
    for edit in edits:
        path = edit.get("path", "")
        path = os.path.expanduser(path)
        edit["path"] = path  # normalize

        if not path:
            error_exit("Edit missing 'path' field")
        if not os.path.isfile(path):
            error_exit(f"File not found: {path}")
        if not edit.get("operations"):
            error_exit(f"No operations for file: {path}")

    # === WAL Phase: backup all files ===
    journal = {}  # path -> { backup_path, original_mode }
    journal_dir = tempfile.mkdtemp(prefix="jarvis-multi-edit-")

    try:
        for i, edit in enumerate(edits):
            path = edit["path"]
            backup_path = os.path.join(journal_dir, f"backup_{i}")
            shutil.copy2(path, backup_path)
            journal[path] = {
                "backup_path": backup_path,
                "original_mode": get_file_mode(path),
            }

        # === Apply Phase: edit all files ===
        results = []
        for edit in edits:
            path = edit["path"]
            operations = edit["operations"]
            old_content = read_file(path)

            try:
                new_content = apply_operations(old_content, operations)
            except ValueError as e:
                if not dry_run:
                    # Rollback all files modified so far
                    for rpath, rinfo in journal.items():
                        try:
                            shutil.copy2(rinfo["backup_path"], rpath)
                            os.chmod(rpath, rinfo["original_mode"])
                        except Exception:
                            pass
                error_exit(f"Error in {path}: {e}")

            diff = generate_diff(old_content, new_content, path)
            language = detect_language(path)

            result = {
                "path": path,
                "language": language,
                "operations_applied": len(operations),
                "diff": diff,
                "old_content": old_content,
                "new_content": new_content,
                "lines_before": old_content.count("\n") + (1 if old_content and not old_content.endswith("\n") else 0),
                "lines_after": new_content.count("\n") + (1 if new_content and not new_content.endswith("\n") else 0),
                "bytes_before": len(old_content.encode("utf-8")),
                "bytes_after": len(new_content.encode("utf-8")),
            }
            results.append(result)

            if not dry_run:
                write_file(path, new_content, journal[path]["original_mode"])

        output = {
            "success": True,
            "dry_run": dry_run,
            "files_modified": len(results) if not dry_run else 0,
            "results": results,
        }
        if show_diff:
            output["__show_diff"] = True
        print(json.dumps(output))

    finally:
        # Cleanup journal directory
        try:
            shutil.rmtree(journal_dir)
        except Exception:
            pass


if __name__ == "__main__":
    main()
