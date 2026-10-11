# Contributing to StillUp

Thanks for helping. StillUp is part of the [R.E.C. product family](https://rec.farm/). Everyone
taking part follows the [rec-farm Code of Conduct](https://github.com/rec-farm/.github/blob/main/CODE_OF_CONDUCT.md).

Report security issues privately through
[GitHub private vulnerability reporting](https://github.com/rec-farm/stillup/security/advisories/new),
never in public issues or pull requests.

## Prerequisites

- Rust 1.92 or later
- Node.js 24 LTS and pnpm 12.6.0 (pinned in `package.json`; `corepack enable` picks it up)
- Docker Compose, for the local PostgreSQL database
- Optional: [portless](https://github.com/vercel-labs/portless), installed globally
  (`npm install -g portless`). Without it, run `PORTLESS=0 pnpm dev` and set
  `APP_ORIGIN=http://localhost:3000`.

## Run it locally

```sh
pnpm install
cp .env.example .env
openssl rand -hex 32   # put the value in ADMIN_TOKEN in .env
docker compose up -d db
pnpm dev:api           # each in its own terminal
pnpm dev:worker
pnpm dev
```

Open http://stillup.localhost:1355 and sign in with the administrator token. See the
[README](README.md#run-locally) for details.

## Before you open a pull request

Run the full check and make sure it passes:

```sh
pnpm check
```

It runs the TypeScript type checks, the unit tests, the Rust tests and a production build. CI also
runs `pnpm format:check`, Clippy, the PostgreSQL integration suites and the Docker image builds; see
[Development and verification](README.md#development-and-verification) to run those locally.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(auth): …`, `fix(ci): …`,
  `chore: …`, `docs: …`, `test(api): …`.
- One change per pull request. Keep unrelated refactors and formatting out of it.
- Describe what changed and how you verified it.

## Rules that matter here

- **No passwords.** People sign in with an installation administrator token or over standard OpenID
  Connect (Handstamp or any other OIDC provider, which must keep working).
- **Identity is `(issuer, subject)`.** Never link or merge accounts by email address.
- **Migrations are append-only.** Never edit a migration that has shipped; add a new one.
- **Secrets stay secret.** Secret values, tokens and keys never appear in logs, API responses, run
  history or error messages (beyond a one-time reveal where the design calls for it).
- **Strict CSP.** Don't add inline scripts or React `style={…}` props; use stylesheets and classes.
- **Design system.** UI follows the
  [REC Design System](https://github.com/rec-farm/rec-brand/blob/main/DESIGN.md) in both Dark and
  Paper themes. Don't edit the copied token block in `apps/web/app/reciam.css` or draw logos here;
  both come from `rec-farm/rec-brand`.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
