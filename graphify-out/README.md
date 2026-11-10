# Repository graph

`graph.json` contains the local Graphify snapshot of code and authored Markdown documents.
Application code, workers, the database schema, and tests form the code graph.
A separate extraction pass adds document headings, links, and code references without model calls.

PR source changes cause automatic graph updates. When inputs match the base, validation uses its graph without extraction.
See `docs/code-graph.md` for scope, writer setup, and local commands.
Do not edit graph data by hand.
