"""Check input selection, freshness, and loop prevention."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).with_name("snapshot.py"))
assert spec is not None and spec.loader is not None
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTests(unittest.TestCase):
    def test_input_scope(self) -> None:
        for path in ("app/a.tsx", "tests/a.test.ts", "docs/api.md", "docs/design.mdx", "README.md"):
            self.assertTrue(snapshot.is_source(path), path)
        for path in ("node_modules/a.ts", "docs/image.jpg", "graphify-out/README.md", "THIRD_PARTY_NOTICES.md",
                     "docs/generated/api.md", "docs/archive/old.md", "app/style.css"):
            self.assertFalse(snapshot.is_source(path), path)

    def test_forged_checksum_is_rejected_without_extraction(self) -> None:
        baseline = {"nodes": [{"id": "real"}], "edges": [], "graph": {}}
        forged = {"nodes": [], "edges": [], "graph": {}}
        forged["graph"]["content_sha256"] = snapshot.content_digest(forged)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "graph.json"
            output.write_text(json.dumps(forged))
            with patch.object(snapshot, "OUTPUT", output), \
                 patch.object(snapshot, "inputs_current", return_value=True), \
                 patch.object(snapshot.subprocess, "check_output", return_value=json.dumps(baseline).encode()), \
                 patch.object(snapshot, "build", side_effect=AssertionError("Unexpected extraction")):
                for mode in ("--check", "--update"):
                    with patch.object(snapshot.sys, "argv", ["snapshot.py", mode, "--base", "base"]):
                        with self.assertRaises(SystemExit):
                            snapshot.main()

    def test_changed_inputs_regenerate_independently(self) -> None:
        with patch.object(snapshot.subprocess, "check_output", return_value=b'{"graph": {}}'), \
             patch.object(snapshot, "inputs_current", return_value=False), \
             patch.object(snapshot, "build", return_value={"nodes": ["generated"]}) as build:
            self.assertEqual(snapshot.expected_graph("base"), {"nodes": ["generated"]})
            build.assert_called_once()

    def test_markdown_pass_preserves_code_edges_and_resolves_citations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "app").mkdir()
            (root / "docs").mkdir()
            (root / "app/greet.ts").write_text("export function greet() { return 'hello'; }\nexport function run() { return greet(); }\n")
            (root / "docs/api.md").write_text("# API\nCall `greet()` for a greeting.\n")
            with patch.object(snapshot, "ROOT", root), \
                 patch.object(snapshot, "source_paths", return_value=["app/greet.ts", "docs/api.md"]):
                graph = snapshot.build()
                self.assertTrue(any(node.get("node_kind") == "heading" for node in graph["nodes"]))
                self.assertTrue(any(edge["relation"] == "calls" for edge in graph["edges"]))
                self.assertTrue(any(edge["relation"] == "references" and edge["source_file"] == "docs/api.md"
                                    for edge in graph["edges"]))

    def test_output_symlink_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "graph.json"
            output.symlink_to(Path(directory) / "other.json")
            with patch.object(snapshot, "OUTPUT", output), patch.object(snapshot.sys, "argv", ["snapshot.py", "--update"]):
                with self.assertRaisesRegex(ValueError, "regular repository file"):
                    snapshot.main()


if __name__ == "__main__":
    unittest.main()
