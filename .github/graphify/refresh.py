"""Merge the base, resolve only generated graph conflicts, and rebuild the graph."""
import base64
import json
import os
import shlex
from pathlib import Path
import subprocess
import sys

TOOLS = Path(__file__).resolve().parent


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", *args], cwd=root)


def refresh(root: Path, base: str) -> bool:
    head = git(root, "rev-parse", "HEAD").decode().strip()
    ancestor = git(root, "merge-base", head, base).decode().strip()
    merge = ancestor != base
    if merge:
        result = subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null",
             "-c", f"merge.graphify.driver={shlex.quote(sys.executable)} -m graphify merge-driver %O %A %B",
             "-c", "user.name=github-actions[bot]",
             "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
             "merge", "--no-commit", "--no-ff", base], cwd=root, check=False,
        )
        conflicts = git(root, "diff", "--name-only", "--diff-filter=U", "-z").decode().split("\0")
        source_conflicts = [name for name in conflicts if name and name != "graphify-out/graph.json"]
        if source_conflicts or (result.returncode and not any(conflicts)):
            git(root, "merge", "--abort")
            raise RuntimeError(f"Source merge needs review: {source_conflicts or 'git merge failed'}")
    # Restore before extraction: never parse or combine JSON conflict markers.
    git(root, "restore", f"--source={base}", "--staged", "--worktree", "--", "graphify-out/graph.json")
    for name in ("snapshot.py", "requirements.txt"):
        candidate = root / ".github" / "graphify" / name
        if candidate.is_symlink() or candidate.read_bytes() != (TOOLS / name).read_bytes():
            raise RuntimeError("Graph tools changed; merge and generate this snapshot locally for review.")
    subprocess.run(
        [sys.executable, str(TOOLS / "snapshot.py"), "--update", "--base", base],
        env={**os.environ, "GRAPHIFY_SOURCE_ROOT": str(root)}, check=True,
    )
    git(root, "add", "--", "graphify-out/graph.json")
    paths = git(root, "diff", "--cached", "--no-renames", "--name-only", "-z", head).decode().split("\0")
    entries: list[dict[str, str | None]] = []
    for path in filter(None, paths):
        index = git(root, "ls-files", "--stage", "-z", "--", path).decode()
        if not index:
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            continue
        mode, sha, stage = index.split("\t", 1)[0].split()
        if stage != "0":
            raise RuntimeError(f"Unresolved index entry: {path}")
        entry: dict[str, str | None] = {"path": path, "mode": mode}
        if mode == "160000":
            entry.update(type="commit", sha=sha)
        else:
            entry.update(type="blob", content=base64.b64encode(git(root, "cat-file", "blob", sha)).decode())
        entries.append(entry)
    changed = merge or bool(entries)
    if changed:
        with (root / "graph-update.json").open("x") as artifact:
            json.dump({"head": head, "base": base, "merge": merge, "entries": entries}, artifact)
    return changed


if __name__ == "__main__":
    changed = refresh(Path(os.environ["GRAPHIFY_SOURCE_ROOT"]).resolve(), os.environ["BASE_SHA"])
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"changed={str(changed).lower()}\n")
