"""Rebuild the graph from the index without including unstaged source edits."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def rebuild(root: Path) -> None:
    tools = Path(__file__).resolve().parent
    graph = "graphify-out/graph.json"
    changed = subprocess.check_output(
        ["git", "diff", "--cached", "--name-only", "-z"], cwd=root,
    ).decode().split("\0")
    if not any(changed):
        return
    with tempfile.TemporaryDirectory(prefix="graphify-index-") as directory:
        staged = Path(directory)
        subprocess.run(
            ["git", "checkout-index", "--all", f"--prefix={staged}/"], cwd=root, check=True,
        )
        for name in ("snapshot.py", "requirements.txt"):
            candidate = staged / ".github/graphify" / name
            if candidate.is_symlink() or candidate.read_bytes() != (tools / name).read_bytes():
                raise SystemExit("Graph tools changed. Review them and rerun clone setup before committing.")
        # Git hooks export index/repository variables; the temporary repo must be independent.
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(GRAPHIFY_SOURCE_ROOT=str(staged), GRAPHIFY_BACKEND="none", PYTHONHASHSEED="0")
        subprocess.run(["git", "init", "--quiet", str(staged)], env=env, check=True)
        subprocess.run(["git", "add", "--all"], cwd=staged, env=env, check=True)
        subprocess.run(
            [sys.executable, "-I", str(tools / "snapshot.py")],
            cwd=staged, env=env, check=True,
        )
        if (root / graph).is_symlink() or (root / graph).parent.is_symlink():
            raise SystemExit("Graph output must be a regular repository file.")
        (root / graph).write_bytes((staged / graph).read_bytes())
    subprocess.run(["git", "add", "--", graph], cwd=root, check=True)


if __name__ == "__main__":
    rebuild(Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()))
