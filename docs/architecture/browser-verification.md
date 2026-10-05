# Native browser verification

Local verification on 2026-10-05 used the Rust release API and worker from `add2f59`, built Vite assets, and a fresh disposable PostgreSQL database. A local mock HTTP target and webhook exercised actual native execution and notification delivery. No production data, user server or remote identity provider was used.

`python3 scripts/browser-fixture.py --seconds 900` starts this bounded installation using the existing local `stillup-db-1` test container. It prints its randomly assigned origins and test-only token. It runs with explicit environment values, without reading project `.env`, and removes its unique `rust_browser_*` database on shutdown. Build the Rust release executable and Vite output first. The private-network allowance applies only to this loopback fixture.

Verified through an isolated agent-browser session:

- Desktop token login, empty dashboard and first-run setup progress.
- Check creation with a successful draft request, followed by the worker's first healthy observation.
- Enabled default webhook channel, test delivery and an attempt displaying HTTP 204.
- Mock target outage, failing dashboard and public status, then recovery; both incident and recovery webhook deliveries succeeded.
- Mobile check details, pause, edit, JSON assertion draft test and save. Revision 2 appeared in configuration history while the check remained paused.
- Mobile documentation search filtered navigation; the secrets guide rendered with its title, copy action changed to “Copied”, and the environment section link updated the URL anchor.
- Mobile public status displayed the paused revised check and the resolved incident under its historical name.

Desktop viewport was 1280 pixels wide; mobile viewport was 390 × 844. Dashboard, check details, secrets documentation and public status had document width equal to viewport width. Inspected screenshots showed readable login, outage status, mobile dashboard/editor and paused public status. Browser error reports were empty for the inspected flows. Screenshots and runtime logs are local ignored artifacts under `artifacts/browser-fixture`; they are not committed assets.

The fixture, API, worker and isolated browser session were stopped, and a database inventory confirmed no `rust_browser_*` database remained.

These checks do not establish complete browser coverage. Appearance controls, secret management, remote-location administration, archive/restore, all documentation routes and keyboard/failure fallback paths remain to be checked. Mobile viewport emulation does not establish physical-device behavior. Live Handstamp OIDC, production data migration and production delivery were not exercised.
