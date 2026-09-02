# Contributing

Thanks for helping make Codex Cloud Console useful to more self-hosted
developers.

## Before opening a pull request

1. Open an issue for significant behavior or architecture changes.
2. Do not include credentials, account IDs, instance IDs, public IPs, local
   absolute paths, conversation contents, or production screenshots.
3. Keep production mutations fail-closed and preserve the existing trust
   boundaries around repository access, webhooks, uploads, and app-server
   operations.
4. Add or update a deterministic regression check for behavior changes.

## Development

```bash
npm ci
npm run verify:local
```

Use Node.js 22 or newer. Pull requests should explain the user-visible change,
security impact, verification performed, and any migration steps.

## Scope

Good contributions include safer AWS deployment defaults, provider-neutral
configuration, tests, accessibility, observability, and documentation.
Project-specific automations should be expressed as examples or configuration,
not embedded production data.

By submitting a contribution, you agree that it is licensed under Apache-2.0.
