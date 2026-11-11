# Repository guidance

Use `graphify-out/graph.json` as the local code and documentation map.
Query it with the local Graphify CLI when available. See `docs/code-graph.md` for setup.
Use focused queries instead of reading the full JSON file.
Check the current source when the graph is stale or an answer is incomplete.

Run the clone setup in `docs/code-graph.md` before committing.
The shared hooks rebuild the staged graph before ordinary and merge commits.
The PR workflow also updates the graph after source or documentation changes.
For fork PRs or graph tool changes, generate and commit the graph locally.
Do not edit graph data by hand. Do not use the cloud graph as the local snapshot.
