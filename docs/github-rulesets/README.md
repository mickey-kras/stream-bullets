# GitHub rulesets

Import both JSON files through **Settings > Rules > Rulesets > New ruleset > Import a ruleset**.
Set each rule to **Active**. Merging the files does not activate protection.

Default-branch protection needs a PR, resolved threads, and passing checks on an up-to-date branch.
It allows squash merges, blocks deletion and force pushes, and permits no bypass.
Required results include CodeQL, Trivy, **GitHub code quality**, and Copilot reviews.
Status names match repository workflows. Aislop needs a status because it uploads no SARIF report.

Branch names follow **GPU Workload Supervisor** rules: `main`, Dependabot, and `feat`, `fix`, `refactor`, `docs`, `ci`, `security`, or `release` prefixes.
The rules also allow `graph`, used by the earlier **Publish graph** workflow.

SonarQube gates deployment from `main`. PR rules do not need its status because the job runs only on `main`.
