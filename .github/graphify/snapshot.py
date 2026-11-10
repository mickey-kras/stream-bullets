"""Build or check the committed, code and documentation Graphify snapshot."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from importlib.metadata import version


TOOLS = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("GRAPHIFY_SOURCE_ROOT", TOOLS.parents[1])).resolve()
OUTPUT = ROOT / "graphify-out" / "graph.json"


def is_source(name: str) -> bool:
    path = Path(name)
    return (
        path.parts[0] in {"app", "db", "worker", "tests"} and path.suffix in {".ts", ".tsx"}
    ) or name in {"README.md", "AGENTS.md", "SECURITY.md"} or (
        path.parts[0] == "docs" and path.suffix in {".md", ".mdx"}
        and not any(part in {"generated", "archive", "changelog"} for part in path.parts)
    )


def tool_digest() -> str:
    digest = hashlib.sha256()
    for name in ("snapshot.py", "requirements.txt"):
        digest.update((TOOLS / name).read_bytes())
    return digest.hexdigest()


def content_digest(graph: dict[str, object]) -> str:
    content = {key: value for key, value in graph.items() if key != "graph"}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


def inputs_current(graph: dict[str, object]) -> bool:
    metadata = graph["graph"]
    return (metadata.get("source_sha256") == source_digest(source_paths())
            and metadata.get("tool_sha256") == tool_digest())


def expected_graph(base: str | None) -> dict[str, object]:
    if base:
        baseline = json.loads(subprocess.check_output(
            ["git", "show", f"{base}:graphify-out/graph.json"], cwd=ROOT
        ))
        if inputs_current(baseline):
            return baseline
    return build()


def source_paths() -> list[str]:
    paths = subprocess.check_output(
        ["git", "ls-files", "-z", "--", "app", "db", "worker", "tests", "docs", "README.md", "AGENTS.md", "SECURITY.md"], cwd=ROOT
    ).decode().split("\0")
    sources = sorted(path for path in paths if path and is_source(path))
    if not sources:
        raise ValueError("No tracked graph sources found")
    return sources


def source_digest(sources: list[str]) -> str:
    digest = hashlib.sha256()
    for name in sources:
        source = ROOT / name
        if source.is_symlink() or not source.resolve().is_relative_to(ROOT):
            raise ValueError(f"Source must be a regular repository file: {name}")
        digest.update(name.encode() + b"\0" + hashlib.sha256(source.read_bytes()).digest())
    return digest.hexdigest()


def build() -> dict[str, object]:
    sources = source_paths()
    with tempfile.TemporaryDirectory(prefix="graphify-") as temporary:
        scan = Path(temporary) / "source"
        scan.mkdir()
        for name in sources:
            source = ROOT / name
            if source.is_symlink() or not source.resolve().is_relative_to(ROOT):
                raise ValueError(f"Source must be a regular repository file: {name}")
            content = source.read_bytes()
            target = scan / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        env = {**os.environ, "GRAPHIFY_BACKEND": "none", "PYTHONHASHSEED": "0"}
        subprocess.run(
            [sys.executable, "-m", "graphify", "extract", str(scan), "--code-only",
             "--no-cluster", "--max-workers", "1", "--out", temporary],
            cwd=scan, env=env, check=True,
        )
        graph = json.loads((Path(temporary) / "graphify-out" / "graph.json").read_text())
        # A separate deterministic Markdown pass adds headings, links and code citations.
        from graphify.extract import extract
        from graphify.build import build as merge_graphs
        from graphify.export import to_json
        documents = [scan / name for name in sources if Path(name).suffix in {".md", ".mdx"}]
        docs = extract(documents, root=scan, cache_root=Path(temporary) / "docs-cache",
                       parallel=False, resolution_context_nodes=graph["nodes"],
                       resolution_context_edges=graph["edges"])
        if docs["failed_sources"]:
            raise ValueError(f"Documentation extraction failed: {docs['failed_sources']}")
        merged = merge_graphs([graph, docs], directed=True, dedup=False, root=scan)
        merged_path = Path(temporary) / "merged.json"
        if not to_json(merged, {}, str(merged_path), force=True, original_links=graph["edges"] + docs["edges"]):
            raise ValueError("Graph export failed")
        graph = json.loads(merged_path.read_text())
        graph["edges"] = graph.pop("links")
    for key in ("nodes", "edges", "hyperedges"):
        graph[key] = sorted(graph.get(key, []), key=lambda item: json.dumps(item, sort_keys=True))
    graph["graph"] = {
        "graphify_version": version("graphifyy"),
        "source_sha256": source_digest(sources),
        "tool_sha256": tool_digest(),
        "content_sha256": content_digest(graph),
        "scope": "Application TypeScript and authored Markdown documentation",
    }
    return graph


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--update", action="store_true", help="Build only when inputs are stale")
    parser.add_argument("--base", help="Trusted base commit for unchanged-input comparison")
    args = parser.parse_args()
    if OUTPUT.is_symlink() or OUTPUT.parent.is_symlink():
        raise ValueError("Graph output must be a regular repository file")
    if args.update and ROOT != TOOLS.parents[1]:
        for name in ("snapshot.py", "requirements.txt"):
            candidate = ROOT / ".github" / "graphify" / name
            if candidate.is_symlink() or candidate.read_bytes() != (TOOLS / name).read_bytes():
                print("Graph tools changed; generate this snapshot locally for review.")
                return
    existing = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else None
    graph = expected_graph(args.base) if args.check or args.update else build()
    if args.check:
        if existing != graph:
            raise SystemExit("Graph is stale or modified. Regenerate the graph.")
        print("Graph matches the independent reference.")
        return
    if args.update and existing == graph:
        print("Graph is current; no commit needed.")
        return
    if args.base and inputs_current(graph) and existing is not None:
        baseline = json.loads(subprocess.check_output(
            ["git", "show", f"{args.base}:graphify-out/graph.json"], cwd=ROOT
        ))
        if inputs_current(baseline) and existing != baseline:
            raise SystemExit("Graph data changed without inputs; restore the base graph.")
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(graph, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
