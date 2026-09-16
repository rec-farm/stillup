# Workspace appearance

Open **Appearance** in the dashboard sidebar (beside the brand on phones). An administrator can change:

- Company/workspace name and welcome message.
- Public HTTPS logo URL, with the StillUp mark as a fallback if the image cannot load.
- Five accent presets or a custom six-digit hex color.
- Comfortable or compact dashboard spacing.

The editor previews changes before saving. **Cancel** leaves the installation unchanged; **Reset draft** restores StillUp defaults in the editor and still requires **Save appearance**. Settings are stored in PostgreSQL and apply to everyone on the installation after a page load. The administrator saving sees the update immediately. No rebuild or environment-variable change is required.

The company name, logo, welcome message, and accent are also used on sign-in. Treat these fields as public branding: the unauthenticated `GET /v1/public/workspace` endpoint intentionally returns only those display settings (including density). It does not expose checks, credentials, or configuration revisions. Logos are fetched directly by visitors' browsers, so use a reliable publicly accessible image owned by your organization.

Brand colors style navigation, controls, and decorative elements. Healthy/failing indicators retain their semantic colors. Button colors are darkened when necessary to maintain at least 4.5:1 contrast with white labels.

Public status-page identity remains independent. Use **Customize status page** for its brand name, logo, accent, introduction, and website link. Workspace branding does not change which checks are published.

## Deployment and API

Migration `007_workspace_appearance.sql` adds a singleton `workspace_settings` table. The normal API startup migration applies it; include this table in database backups. The standalone web Docker image includes `public/` assets for the fallback logo.

- `GET /v1/workspace` — authenticated settings and revision.
- `PUT /v1/workspace` — authenticated `{ config, expectedRevision }` update; existing origin checks apply.
- `GET /v1/public/workspace` — public display settings for server-rendered branding.

A stale revision returns HTTP 409. Close and reopen the editor to load the latest settings before saving again. This also protects two administrators creating initial settings simultaneously.
