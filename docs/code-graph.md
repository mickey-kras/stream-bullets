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

## Clone setup

Run this setup in each clone. Git does not copy local driver or hook configuration.
The setup registers Graphify's native graph merge driver and the shared commit hooks.
The setup stops if the clone already uses other hooks.

Run setup only from reviewed source. It copies hooks and graph tools into `.git/graphify`.
Installed hooks reject changes to the staged extractor or its requirements.
Review tool changes before you run setup again.

```sh
python3.12 -m venv ~/.local/share/stream-bullets-graphify
~/.local/share/stream-bullets-graphify/bin/python -m pip install --require-hashes -r .github/graphify/requirements.txt
~/.local/share/stream-bullets-graphify/bin/python .github/graphify/setup.py
```

The hooks rebuild and stage `graph.json` before ordinary and merge commits.
For local merges, use `git merge --no-commit` followed by `git commit`.
If an automatic merge rebuild changes the graph, the hook pauses the commit.
Run `git commit` to finish. The hook staged the graph.

The hooks extract staged files in a temporary checkout. Unstaged source edits remain outside the graph.
Extraction failures stop the commit. Git tracks only `graph.json`. Other graph output stays local.

The merge driver combines graph nodes and edges. The hook then rebuilds from source to remove stale nodes.
The rebuild uses our code and Markdown extractor, with pinned dependencies and no model calls.
Do not use `graphify hook install`: its post-commit rebuild leaves the graph outside the source commit.

GitHub cannot use a merge driver installed in your clone. The PR updater still handles server-side conflicts.
It reads the current base branch reference, not the PR's recorded base commit.

For a controlled CI commit that already rebuilt the graph, set `GRAPHIFY_SKIP_HOOK=1`.
Normal development commits must use the hooks.

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
