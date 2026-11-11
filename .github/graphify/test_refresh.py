"""Exercise automatic graph conflict resolution with real Git histories."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("refresh", Path(__file__).with_name("refresh.py"))
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class RefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        (self.root / "graphify-out").mkdir()
        self.graph = self.root / "graphify-out/graph.json"
        self.graph.write_text('{"version": "initial"}\n')
        (self.root / "source.ts").write_text('original\n')
        tools = self.root / ".github/graphify"
        tools.mkdir(parents=True)
        # Stub only extraction; all merge/index operations use real Git.
        (tools / "snapshot.py").write_text(
            "import os\nfrom pathlib import Path\n"
            "(Path(os.environ['GRAPHIFY_SOURCE_ROOT']) / 'graphify-out/graph.json').write_text('{\"rebuilt\": true}\\n')\n"
        )
        (tools / "requirements.txt").write_text('')
        self.commit()
        self.git("switch", "-c", "feature")
        self.graph.write_text('{"version": "feature"}\n')
        (self.root / "feature.ts").write_text('feature\n')
        self.commit()
        self.head = self.git("rev-parse", "HEAD")
        self.git("switch", "main")
        self.graph.write_text('{"version": "main"}\n')
        (self.root / "main.ts").write_text('main\n')
        self.commit()
        self.base = self.git("rev-parse", "HEAD")
        self.git("switch", "feature")
        self.tools = tools

    def git(self, *args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.DEVNULL).decode().strip()

    def commit(self) -> None:
        self.git("add", ".")
        self.git("commit", "-m", "fixture")

    def test_graph_conflict_merges_both_sources(self) -> None:
        with patch.object(refresh, "TOOLS", self.tools):
            self.assertTrue(refresh.refresh(self.root, self.base))
        self.assertEqual(self.git("diff", "--name-only", "--diff-filter=U"), "")
        self.assertTrue((self.root / "main.ts").exists())
        self.assertTrue((self.root / "feature.ts").exists())
        artifact = json.loads((self.root / "graph-update.json").read_text())
        self.assertTrue(artifact["merge"])
        self.assertEqual(artifact["head"], self.head)
        self.assertEqual(artifact["base"], self.base)
        self.assertEqual({entry["path"] for entry in artifact["entries"]}, {"main.ts", "graphify-out/graph.json"})
        self.assertEqual(json.loads(self.graph.read_text()), {"rebuilt": True})

    def test_source_conflict_aborts_without_artifact(self) -> None:
        (self.root / "source.ts").write_text('feature edit\n')
        self.commit()
        before = self.git("rev-parse", "HEAD")
        self.git("switch", "main")
        (self.root / "source.ts").write_text('main edit\n')
        self.commit()
        base = self.git("rev-parse", "HEAD")
        self.git("switch", "feature")
        with patch.object(refresh, "TOOLS", self.tools), self.assertRaisesRegex(RuntimeError, 'source.ts'):
            refresh.refresh(self.root, base)
        self.assertFalse((self.root / "graph-update.json").exists())
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.git("rev-parse", "HEAD"), before)

    def test_current_base_uses_single_parent_update(self) -> None:
        self.git("switch", "main")
        with patch.object(refresh, "TOOLS", self.tools):
            self.assertTrue(refresh.refresh(self.root, self.base))
        artifact = json.loads((self.root / "graph-update.json").read_text())
        self.assertFalse(artifact["merge"])
        self.assertEqual([entry["path"] for entry in artifact["entries"]], ["graphify-out/graph.json"])

    def test_current_graph_does_not_publish_again(self) -> None:
        self.git("switch", "main")
        self.graph.write_text('{"rebuilt": true}\n')
        self.commit()
        base = self.git("rev-parse", "HEAD")
        with patch.object(refresh, "TOOLS", self.tools):
            self.assertFalse(refresh.refresh(self.root, base))
        self.assertFalse((self.root / "graph-update.json").exists())

    def test_deleted_file_is_preserved_in_merge_artifact(self) -> None:
        self.git("switch", "main")
        self.git("rm", "source.ts")
        self.commit()
        base = self.git("rev-parse", "HEAD")
        self.git("switch", "feature")
        with patch.object(refresh, "TOOLS", self.tools):
            self.assertTrue(refresh.refresh(self.root, base))
        artifact = json.loads((self.root / "graph-update.json").read_text())
        deleted = next(entry for entry in artifact["entries"] if entry["path"] == 'source.ts')
        self.assertIsNone(deleted["sha"])
        self.assertFalse((self.root / "source.ts").exists())
