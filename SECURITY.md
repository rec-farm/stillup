# Security Policy

## Supported Versions

Security fixes are handled on the `master` branch until the project publishes versioned releases.

## Reporting a Vulnerability

Please do not open public issues for suspected vulnerabilities.

Report security issues privately through GitHub's private vulnerability reporting: https://github.com/rec-farm/stillup/security/advisories/new

Include:

- A clear description of the issue
- Steps to reproduce
- Affected routes, APIs, probes, or dependencies
- Any known mitigation

## Secrets

Never commit `.env` files, `ADMIN_TOKEN`, `OIDC_CLIENT_SECRET`, `SECRETS_ENCRYPTION_KEY`, API keys, probe credentials, database dumps, or production logs. Use `.env.example` for placeholder configuration only.
