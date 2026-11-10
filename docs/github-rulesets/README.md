# GitHub rulesets

Import both JSON files in repository Settings > Rules > Rulesets > New ruleset > Import a ruleset.
Set enforcement to Active when you save each rule.
These files do not activate protection when merged.

The default branch rule requires a pull request, resolved review threads, and successful checks on an up-to-date branch.
It permits squash merges and blocks deletion and force pushes, with no bypass actors.
It also requires CodeQL and Trivy results, GitHub code quality checks, and automatic Copilot reviews.
The status check names match this repository's workflows.
Aislop is required through its status check because this repository does not upload its SARIF report.

The branch name rule matches GPU Workload Supervisor.
It permits main, Dependabot, and the feat, fix, refactor, docs, ci, security, and release prefixes.

SonarQube remains a main-branch deployment gate, as in GPU Workload Supervisor.
Its status is not required on pull requests because that job does not run there.
