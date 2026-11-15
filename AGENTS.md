# Repository guidance

Use `graphify-out/graph.json` to map code and documentation.
Use focused local Graphify queries, not a full JSON read.
Check the current source when the graph is stale or incomplete.

Complete [clone setup](docs/code-graph.md#clone-setup) before committing.
Hooks rebuild and stage the graph. CI rejects stale graphs.
Do not edit graph data manually or substitute the cloud graph.
