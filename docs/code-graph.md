# Repository graph

Git tracks `graphify-out/graph.json`, built with Graphify 0.9.105 without model calls.
It maps application code, workers, the TypeScript schema, tests, and authored Markdown.
The setup follows Graphify's shared team graph guide.

## Clone setup

Run once per clone with Python 3.12:

```sh
python3.12 -m venv ~/.local/share/stream-bullets-graphify
~/.local/share/stream-bullets-graphify/bin/python -m pip install --require-hashes -r .github/graphify/requirements.txt
git config core.hooksPath .github/graphify/hooks
git config graphify.python ~/.local/share/stream-bullets-graphify/bin/python
git config merge.graphify.name "graphify graph.json union merge"
git config merge.graphify.driver "$HOME/.local/share/stream-bullets-graphify/bin/python -m graphify merge-driver %O %A %B"
```

## Commits and merges

`pre-commit` rebuilds and stages the graph after source changes.
`pre-merge-commit` does the same for merges without conflicts.
If it changes the graph, it stops the merge. Run `git commit` to finish.
The merge driver combines conflicting graphs. The hook then rebuilds from merged sources.

GitHub cannot run the driver. Resolve graph conflicts locally:

```sh
git fetch origin main
git merge origin/main
```

## Checks

CI rebuilds the graph and rejects differences. Run the same check locally:

```sh
python .github/graphify/snapshot.py --check
```

For a controlled commit without the hook, set `GRAPHIFY_SKIP_HOOK=1`.

## Remove the old setup

Remove the old copied hooks if present. Then repeat clone setup:

```sh
rm -rf "$(git rev-parse --git-path graphify)"
```

## Scope and queries

Code extraction covers tracked TypeScript and TSX in `app`, `db`, `worker`, and `tests`.
Markdown extraction covers `README.md`, `AGENTS.md`, `SECURITY.md`, and authored documents under `docs`.
It adds headings, document links, and code-symbol references without model inference.

Excluded: assets, translations, dependencies, build output, SQL migrations, CI tools, and documents under `generated`, `archive`, or `changelog`.
The TypeScript schema supplies database structure.

Use focused queries:

```sh
graphify query 'How are images uploaded?' --graph graphify-out/graph.json --budget 2000
```

Check the source when graph edges are absent or unclear. Graphs do not prove behavior.
This setup uses neither the cloud index nor the review bot.
