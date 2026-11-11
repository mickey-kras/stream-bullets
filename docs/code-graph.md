# Repository graph

The graph is in `graphify-out/graph.json`. It uses Graphify 0.9.105 with no model calls.
It includes application code, workers, the TypeScript database schema, tests, and authored Markdown documents.

## Automatic updates

When a PR opens or receives commits, the updater merges the latest `main` into its branch.
A push to `main` starts an update for each open PR in this repository.
The Update branch button also starts an update when it adds a commit.

The updater takes the base graph and rebuilds it from the combined sources.
It resolves conflicts in `graphify-out/graph.json` automatically. Source conflicts stop the update for review.
GitHub can show a graph conflict until the update finishes.
The generated-file attribute hides graph diffs. It does not change GitHub merge behavior.

A newer run cancels the older run for that PR. Before publishing, the updater checks both the PR head and base again.
It never force-pushes. Thus, an old build cannot replace a newer source commit.

When inputs match the base, CI compares the graph with the base graph without extraction.
When inputs differ, CI independently rebuilds the graph to check its content.
The updater preserves source changes from both branches. All quality gates run on its commit.

Automatic writes apply only to branches in this repository. Fork contributors must generate the graph locally.

PRs that change the extractor or its dependencies must also generate the graph locally for review.
The updater executes trusted tools from the default branch and treats candidate files as data.

## Graph commits

The updater uses the built-in `GITHUB_TOKEN`. It needs no separate App or Graphify Cloud account.
The write job runs separately from extraction. It publishes the merged tree and rebuilt graph.
The merge commit records both parents. Source conflicts cannot produce a publication artifact.

After the commit, it starts quality checks for that revision and trusted policy validation.
Each run rejects a stale PR revision. These checks do not start another graph update.
The workflow needs write access to repository contents and Actions, plus read access to pull requests.

## Local update

Use Python 3.12. From the repository root:

```sh
python3.12 -m venv /tmp/stream-bullets-graphify
. /tmp/stream-bullets-graphify/bin/activate
python -m pip install --require-hashes -r .github/graphify/requirements.txt
git add app db worker tests docs README.md AGENTS.md SECURITY.md
python .github/graphify/snapshot.py
```

Stage added and deleted sources before building. Commit the graph with your changes.
To rebuild and check freshness without changing files, run:

```sh
python .github/graphify/snapshot.py --check
```

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
