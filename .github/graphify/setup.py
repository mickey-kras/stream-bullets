"""Register the pinned Graphify merge driver and shared hook in this clone."""
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
from importlib.metadata import version


def setup() -> None:
    root = Path(__file__).resolve().parents[2]
    if version("graphifyy") != "0.9.105":
        raise SystemExit("Install the pinned .github/graphify/requirements.txt first.")
    installed = Path(subprocess.check_output(
        ["git", "rev-parse", "--path-format=absolute", "--git-path", "graphify"], cwd=root, text=True,
    ).strip())
    configured = subprocess.run(
        ["git", "config", "--get", "core.hooksPath"], cwd=root,
        capture_output=True, text=True, check=False,
    )
    if configured.returncode not in (0, 1):
        raise SystemExit(configured.stderr)
    old_hook = subprocess.check_output(
        ["git", "rev-parse", "--git-path", "hooks/pre-commit"], cwd=root, text=True,
    ).strip()
    if configured.stdout.strip() not in ("", str(installed / "hooks")) or (
        not configured.stdout.strip() and (root / old_hook).exists()
    ):
        raise SystemExit("Existing hooks found. Integrate .github/graphify/hooks/pre-commit before changing core.hooksPath.")
    # Keep the venv executable path: resolving its symlink loses the environment.
    python = str(Path(sys.executable).absolute())
    if Path(python).is_relative_to(root):
        raise SystemExit("Install Graphify in a virtual environment outside the checkout.")
    installed.mkdir(parents=True, exist_ok=True)
    for name in ("pre_commit.py", "snapshot.py", "requirements.txt"):
        shutil.copy2(Path(__file__).parent / name, installed / name)
    shutil.copytree(Path(__file__).parent / "hooks", installed / "hooks", dirs_exist_ok=True)
    for key, value in {
        "merge.graphify.name": "Graphify graph.json union merge",
        "merge.graphify.driver": f"{shlex.quote(python)} -I -m graphify merge-driver %O %A %B",
        "graphify.python": python,
        "core.hooksPath": str(installed / "hooks"),
    }.items():
        subprocess.run(["git", "config", "--local", key, value], cwd=root, check=True)
    print("Registered the Graphify merge driver and pre-commit hook in this clone.")


if __name__ == "__main__":
    setup()
