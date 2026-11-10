# GitHub rulesets

Import both JSON files through **Settings > Rules > Rulesets > New ruleset > Import a ruleset**.
Set the enforcement to **Active** when you save each rule.
A merge of these files does not activate protection.

The rule for the default branch requires a **pull request**, resolved review threads, and successful checks on an up-to-date branch.
It permits squash merges and blocks deletion and force pushes.
Nobody can bypass the rule.

It also requires results from CodeQL and Trivy, checks from **GitHub code quality**, and reviews from Copilot.
The names of the status checks match the workflows in this repository.
The Aislop status check is mandatory because this repository does not upload its SARIF report.

The rule for branch names matches the rule in **GPU Workload Supervisor**.
It permits `main`, Dependabot, and the `feat`, `fix`, `refactor`, `docs`, `ci`, `security`, and `release` prefixes.

SonarQube remains a gate for deployment from `main`, as in **GPU Workload Supervisor**.
The rule does not need its status on a **pull request** because that job does not run there.
