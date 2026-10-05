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

## Additional pass at `d13e4f5`

A second disposable installation verified the secret creation UI and submitted a replacement value through the rotation form. The saved overview displayed encrypted-secret metadata and a named reference, without showing the original value. Location administration created an enrollment, confirmed replacement, and confirmed revocation; the revoked entry no longer offered a revoke action.

The public-page editor saved the Midnight preset with a custom title and brand name. A fresh public navigation displayed the saved identity, dark palette, matching document title and `#0b1020` theme-color. The inspected mobile screenshot remained readable at 390 pixels, with document width 390.

All nine guide routes rendered their expected headings at the mobile viewport with no page overflow. The `/` keyboard shortcut focused the documentation search input. A separate fresh browser context aborted the documentation JavaScript chunk before navigation: the monitoring-as-code guide retained its static heading, navigation, prose and code (over 7,000 text characters). Its inspected screenshot and document width confirmed a readable mobile fallback. The first attempted abort reused a warmed context and rendered the interactive guide, so only the fresh-context result establishes chunk-failure behavior.

Both browser contexts, native API and worker were stopped. The second fixture removed its unique database, and inventory showed no `rust_browser_*` database remained.

## Check lifecycle at `ce8fed6`

A third isolated installation seeded one check through the native API, then used the authenticated browser to archive it with confirmation. After a fresh dashboard navigation, the Archived filter showed the retained check. Restoring returned it in the paused state with Run now disabled. Resume was invoked before another dashboard navigation; its persisted state was not separately inspected in this browser pass (native PostgreSQL tests cover that transition). The fixture and browser session were stopped and the unique database removed.

## Appearance and persisted metadata

Another disposable installation prepared state through native HTTP APIs, then inspected it through fresh browser navigations. Secret rotation persisted at revision 2; the overview displayed its check usage without showing stored values. A native test request using the named reference passed. Location enrollment replacement changed the token, revocation persisted, and the browser displayed the location as revoked without a revoke action. These are persistence/rendering checks; creation/rotation/revocation form interactions were exercised in the earlier pass.

Saved workspace identity/density and public serif typography, compact layout, corner radius, navigation link and content section rendered through the native runtime. The custom public logo deliberately pointed at an invalid local TLS/image response. After network idle, the image was removed, the brand name remained visible, and the inspected 390-pixel screenshot was readable with document width 390. The saved public document title matched. Both browser and runtime were stopped and the unique database removed.

Remaining verification boundaries include documentation keyboard/failure paths beyond the tested search shortcut and chunk failure. These samples do not exercise every possible custom palette or settings combination. Mobile viewport emulation does not establish physical-device behavior. Live Handstamp OIDC, production data migration and production delivery were not exercised.
