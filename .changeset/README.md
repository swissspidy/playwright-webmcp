# Changesets

This repository uses [changesets](https://github.com/changesets/changesets) to version and publish the packages.

- Run `pnpm changeset` in a pull request that changes a published package and pick a bump. The four packages are versioned together, so one changeset covers all of them.
- When changesets land on `main`, the release workflow opens a "Version Packages" pull request that bumps versions and updates `CHANGELOG.md` files.
- Merging that pull request publishes to npm with provenance.

## What the release workflow needs

- An `NPM_TOKEN` repository secret: a granular npm access token with read and write permission for the four packages (or, before the first publish, for new packages under the account), with two-factor bypass enabled so it can publish unattended. The workflow hands it to npm through `NODE_AUTH_TOKEN`.
- "Allow GitHub Actions to create and approve pull requests" enabled under Settings → Actions → General, so the action can open the "Version Packages" pull request.

Publishing already runs with `id-token: write` and provenance. Once the packages exist on npm, npm's trusted publishing can replace the token: configure this repository and workflow as a trusted publisher on each package, then drop the secret.
