# Repository graph

The graph uses Graphify 0.9.105 with no model calls.
It includes application code, workers, the TypeScript database schema, tests, and authored Markdown documents.

## Where the graph is

A PR does not contain the graph. Git does not track `graphify-out/`.
After each push to `main`, a workflow builds the graph and publishes it to the `graph` branch.
That branch has one commit with one file, `graph.json`. Each publication replaces the commit.
The commit message names the `main` commit that the graph shows.

Thus, PRs have no graph conflicts and no generated commits.

## Get the graph

To use the graph of the latest `main`, run these commands from the repository root:

```sh
git fetch origin graph
mkdir -p graphify-out
git show FETCH_HEAD:graph.json > graphify-out/graph.json
```

This graph does not show the changes on your branch.

## Build the graph locally

To include the changes on your branch, build the graph. Use Python 3.12.

```sh
python3.12 -m venv ~/.local/share/stream-bullets-graphify
~/.local/share/stream-bullets-graphify/bin/python -m pip install --require-hashes -r .github/graphify/requirements.txt
~/.local/share/stream-bullets-graphify/bin/python .github/graphify/snapshot.py
```

The build reads the tracked files in the working tree. Add new files to Git before you build.
The build takes about 15 seconds.

## Checks

The Graphify snapshot job in each PR runs the extractor tests and builds the graph.
It does not compare the graph with a committed copy.
Changes to the extractor or its requirements need the usual CI policy approval.

## Remove the old clone setup

Earlier versions of this repository installed commit hooks and a merge driver in each clone.
These hooks try to stage the graph. Now that Git ignores the graph, they stop each commit.
If you ran the old setup, remove it:

```sh
git config --local --unset core.hooksPath
git config --local --remove-section merge.graphify
git config --local --unset graphify.python
rm -rf "$(git rev-parse --git-path graphify)"
```

A command fails if its setting is not in this clone. You can ignore that failure.

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
