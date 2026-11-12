# Repository graph

The graph is in `graphify-out/graph.json`. Git tracks only this file.
The graph uses Graphify 0.9.105 with no model calls.
It includes application code, workers, the TypeScript database schema, tests, and authored Markdown documents.

This setup follows the Graphify guide for a shared team graph.

## Clone setup

Do these steps one time in each clone. Use Python 3.12.

```sh
python3.12 -m venv ~/.local/share/stream-bullets-graphify
~/.local/share/stream-bullets-graphify/bin/python -m pip install --require-hashes -r .github/graphify/requirements.txt
git config core.hooksPath .github/graphify/hooks
git config graphify.python ~/.local/share/stream-bullets-graphify/bin/python
git config merge.graphify.name "graphify graph.json union merge"
git config merge.graphify.driver "$HOME/.local/share/stream-bullets-graphify/bin/python -m graphify merge-driver %O %A %B"
```

## Commits and merges

The `pre-commit` hook rebuilds the graph and stages it when you commit source changes.
The `pre-merge-commit` hook does the same for a merge without conflicts.
If that hook changes the graph, it stops the merge. Run `git commit` to finish.

The merge driver combines two graphs when both branches change the graph.
The hook then rebuilds the graph from the merged source.

GitHub cannot use the merge driver. If a PR shows a conflict in `graph.json`, merge `main` in your clone:

```sh
git fetch origin main
git merge origin/main
```

## Checks

The Graphify snapshot job in CI rebuilds the graph and compares it with the committed file.
The job fails if the graph does not match the sources. Thus, `main` always has a current graph.
To do the same check locally, run:

```sh
python .github/graphify/snapshot.py --check
```

For a controlled commit that does not need the hook, set `GRAPHIFY_SKIP_HOOK=1`.

## Remove the old setup

Earlier versions copied hooks into `.git/graphify`. If your clone has them, remove them:

```sh
rm -rf "$(git rev-parse --git-path graphify)"
```

Then do the clone setup again.

## Scope and queries

Code extraction covers tracked TypeScript and TSX in `app`, `db`, `worker`, and `tests`.
A separate Markdown pass covers `README.md`, `AGENTS.md`, `SECURITY.md`, and authored Markdown under `docs`.
It adds headings, document links, and references to code symbols.
It does not infer concepts from prose with a model.

The graph excludes assets, translations, installed dependencies, build output, SQL migrations, and CI tools.
It also excludes documents under `generated`, `archive`, and `changelog` directories.
The TypeScript schema supplies the database structure.

Use focused queries:

```sh
graphify query 'How are images uploaded?' --graph graphify-out/graph.json --budget 2000
```

The graph is a map, not proof of program behavior. Check the source when an edge is absent or unclear.
The cloud index and review bot are separate services. This setup does not use them.
