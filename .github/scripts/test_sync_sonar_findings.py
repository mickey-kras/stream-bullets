from __future__ import annotations

import importlib.util
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


def load_sync() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "sync_sonar_findings", Path(__file__).with_name("sync-sonar-findings.py")
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


sync: ModuleType = load_sync()


class SonarPayloadTests(unittest.TestCase):
    def test_get_preserves_nested_json_and_rejects_nonobjects(self) -> None:
        client = sync.SonarClient("https://sonar.example", "test-token")
        payload: dict[str, object] = {"issues": [{"key": "one", "impacts": [{"severity": "HIGH"}]}]}
        with patch.object(sync.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(payload).encode())):
            self.assertEqual(client.get("/api/issues/search"), payload)
        for value in [None, [], "invalid", 1]:
            with self.subTest(value=value):
                with patch.object(sync.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(value).encode())):
                    with self.assertRaisesRegex(RuntimeError, "invalid JSON"):
                        client.get("/api/issues/search")

    def test_paging_preserves_numeric_string_totals_and_object_filtering(self) -> None:
        client = sync.SonarClient("https://sonar.example", "test-token")
        with patch.object(client, "get", side_effect=[
            {"issues": [{"key": "one"}, None], "paging": {"total": "2"}},
            {"issues": [{"key": "two"}], "total": 2},
        ]) as get:
            self.assertEqual(client.paged("/api/issues/search", "issues"), [{"key": "one"}, {"key": "two"}])
            self.assertEqual(get.call_count, 2)

    def test_invalid_collection_and_paging_fail_closed(self) -> None:
        client = sync.SonarClient("https://sonar.example", "test-token")
        for payload in [
            {"issues": {}}, {"issues": [], "paging": []},
            {"issues": [], "paging": {"total": None}},
            {"issues": [], "paging": {"total": {}}},
        ]:
            with self.subTest(payload=payload):
                with patch.object(client, "get", return_value=payload):
                    with self.assertRaises(RuntimeError):
                        client.paged("/api/issues/search", "issues")

    def test_forbidden_later_page_retains_existing_findings(self) -> None:
        client = sync.SonarClient("https://sonar.example", "test-token")
        forbidden = urllib.error.HTTPError("https://sonar.example", 403, "Forbidden", None, None)
        with patch.object(client, "get", side_effect=[
            {"issues": [{"key": "one"}], "paging": {"total": 2}}, forbidden,
        ]):
            with patch("sys.stderr", new_callable=io.StringIO):
                result = sync.optional_paged(client, "/api/issues/search", "issues")
        self.assertTrue(result.forbidden)
        self.assertEqual(result.values, [{"key": "one"}])


if __name__ == "__main__":
    unittest.main()
