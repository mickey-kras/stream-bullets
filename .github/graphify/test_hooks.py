"""Exercise installed hooks, staged extraction, and the native merge driver."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parent


class HookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="graph hooks ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        shutil.copytree(TOOLS.parents[1] / ".githooks", self.root / ".githooks")
        target = self.root / ".github/graphify"
        target.mkdir(parents=True)
        for name in ("setup.py", "pre_commit.py"):
            shutil.copy(TOOLS / name, target / name)
        (target / "snapshot.py").write_text(
            "from pathlib import Path\n"
            "Path('graphify-out/graph.json').write_text(Path('source.ts').read_text())\n"
        )
        (self.root / "graphify-out").mkdir()
        (self.root / "graphify-out/graph.json").write_text("old")
        (self.root / "source.ts").write_text("staged")
        subprocess.run([sys.executable, str(target / "setup.py")], cwd=self.root, check=True)

    def git(self, *args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=self.root, text=True)

    def test_commit_uses_index_and_keeps_unstaged_source(self) -> None:
        self.git("add", ".")
        (self.root / "source.ts").write_text("unstaged")
        self.git("commit", "-qm", "staged source")
        self.assertEqual(self.git("show", "HEAD:graphify-out/graph.json"), "staged")
        self.assertEqual((self.root / "source.ts").read_text(), "unstaged")

    def test_extraction_failure_blocks_commit(self) -> None:
        (self.root / ".github/graphify/snapshot.py").write_text("raise SystemExit(1)\n")
        self.git("add", ".")
        result = subprocess.run(["git", "commit", "-qm", "must fail"], cwd=self.root, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / "graphify-out/graph.json").read_text(), "old")

    def test_native_driver_merges_graph_nodes(self) -> None:
        (self.root / ".gitattributes").write_text("graphify-out/graph.json merge=graphify\n")
        def write_graph(ids: list[str]) -> None:
            (self.root / "graphify-out/graph.json").write_text(json.dumps({
                "directed": True, "multigraph": False,
                "graph": {}, "nodes": [{"id": value} for value in ids], "edges": [],
            }))
        write_graph(["base"])
        self.git("add", ".")
        env = {**os.environ, "GRAPHIFY_SKIP_HOOK": "1"}
        def commit() -> None:
            subprocess.run(["git", "commit", "-qam", "graph"], cwd=self.root, env=env, check=True)
        commit()
        base = self.git("rev-parse", "HEAD").strip()
        write_graph(["base", "left"])
        commit()
        left = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-qb", "right", base)
        write_graph(["base", "right"])
        commit()
        self.git("merge", "--no-commit", left)
        graph = json.loads((self.root / "graphify-out/graph.json").read_text())
        self.assertEqual({node["id"] for node in graph["nodes"]}, {"base", "left", "right"})
        self.assertEqual(self.git("diff", "--name-only", "--diff-filter=U"), "")
        self.git("merge", "--abort")
        result = subprocess.run(["git", "merge", "--no-edit", left], cwd=self.root, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.git("commit", "-qm", "finish merge with rebuilt graph")
        self.assertEqual(self.git("show", "HEAD:graphify-out/graph.json"), "staged")
