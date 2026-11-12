"""Check input selection, extraction, and output safety."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).with_name("snapshot.py"))
assert spec is not None and spec.loader is not None
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


def stage(root: Path) -> None:
    subprocess.run(["git", "init", "--quiet", str(root)], check=True)
    subprocess.run(["git", "add", "--all"], cwd=root, check=True)


class SnapshotTests(unittest.TestCase):
    def test_input_scope(self) -> None:
        for path in ("app/a.tsx", "tests/a.test.ts", "docs/api.md", "docs/design.mdx", "README.md"):
            self.assertTrue(snapshot.is_source(path), path)
        for path in ("node_modules/a.ts", "docs/image.jpg", "graphify-out/README.md", "THIRD_PARTY_NOTICES.md",
                     "docs/generated/api.md", "docs/archive/old.md", "app/style.css"):
            self.assertFalse(snapshot.is_source(path), path)

    def test_markdown_pass_preserves_code_edges_and_resolves_citations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "app").mkdir()
            (root / "docs").mkdir()
            (root / "app/greet.ts").write_text("export function greet() { return 'hello'; }\nexport function run() { return greet(); }\n")
            (root / "docs/api.md").write_text("# API\nCall `greet()` for a greeting.\n")
            stage(root)
            with patch.object(snapshot, "ROOT", root):
                graph = snapshot.build()
                self.assertTrue(any(node.get("node_kind") == "heading" for node in graph["nodes"]))
                self.assertTrue(any(edge["relation"] == "calls" for edge in graph["edges"]))
                self.assertTrue(any(edge["relation"] == "references" and edge["source_file"] == "docs/api.md"
                                    for edge in graph["edges"]))

    def test_sources_come_from_the_index_not_unstaged_edits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "app").mkdir()
            (root / "app/a.ts").write_text("export const staged = 1;\n")
            stage(root)
            (root / "app/a.ts").write_text("export const unstaged = 2;\n")
            (root / "app/new.ts").write_text("export const untracked = 3;\n")
            with patch.object(snapshot, "ROOT", root):
                self.assertEqual(snapshot.source_files(), {"app/a.ts": b"export const staged = 1;\n"})

    def test_check_rejects_a_stale_graph_and_accepts_a_current_one(self) -> None:
        graph = {"nodes": [{"id": "current"}], "edges": [], "graph": {}}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "graph.json"
            with patch.object(snapshot, "OUTPUT", output), patch.object(snapshot, "build", return_value=graph), \
                 patch.object(snapshot.sys, "argv", ["snapshot.py", "--check"]):
                output.write_text(snapshot.render({"nodes": [], "edges": [], "graph": {}}))
                with self.assertRaisesRegex(SystemExit, "stale"):
                    snapshot.main()
                output.write_text(snapshot.render(graph))
                snapshot.main()

    def test_output_symlink_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "graph.json"
            output.symlink_to(Path(directory) / "other.json")
            with patch.object(snapshot, "OUTPUT", output), patch.object(snapshot.sys, "argv", ["snapshot.py"]), \
                 patch.object(snapshot, "build", side_effect=AssertionError("Unexpected extraction")):
                with self.assertRaisesRegex(ValueError, "regular repository file"):
                    snapshot.main()


if __name__ == "__main__":
    unittest.main()
