# Repository guidance

Use `graphify-out/graph.json` as the local code and documentation map.
Query it with the local Graphify CLI when available.
Use focused queries instead of reading the full JSON file.
Check the current source when the graph is stale or an answer is incomplete.

Do the clone setup in `docs/code-graph.md` before you commit.
The hooks rebuild and stage the graph with each commit.
CI fails when the committed graph does not match the sources.
Do not edit graph data by hand. Do not use the cloud graph as the local snapshot.
