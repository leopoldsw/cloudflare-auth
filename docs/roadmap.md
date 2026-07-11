# Roadmap

Near-term work after v1 focuses on production feedback, additional examples,
migration tooling, and audit improvements.

## Agent Integrations

The one-command setup path ships with an automation contract
([automation.md](automation.md)), an `AGENTS.md` runbook written into every
scaffolded app, and an in-repo Claude Code skill. Publishing the skill as a
plugin/marketplace entry is a post-beta follow-up. An MCP server is not
planned for v1 or beta; a future one would wrap the same setup-report
contract rather than reimplement provisioning.

Not planned for v1:

- OAuth/social login
- SAML/enterprise SSO
- passkeys
- MFA
- organizations/teams
- role/permission framework
- hosted dashboard
- hosted auth service
- billing integration
- admin impersonation
- multi-project control plane
- password peppering

These are listed in [non-goals.md](non-goals.md).
