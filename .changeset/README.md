# Changesets

This repository uses [changesets](https://github.com/changesets/changesets) to version and publish the packages.

- Run `pnpm changeset` in a pull request that changes a published package and pick a bump. The four packages are versioned together, so one changeset covers all of them.
- When changesets land on `main`, the release workflow opens a "Version Packages" pull request that bumps versions and updates `CHANGELOG.md` files.
- Merging that pull request publishes to npm with provenance.

## What the release workflow needs

- An `NPM_TOKEN` repository secret: a granular npm access token with read and write permission for the four packages (or, before the first publish, for new packages under the account), with two-factor bypass enabled so it can publish unattended. The workflow exposes it only to the publish step, through `NODE_AUTH_TOKEN`.
- "Allow GitHub Actions to create and approve pull requests" enabled under Settings → Actions → General, so the action can open the "Version Packages" pull request.

Publishing already runs with `id-token: write` and provenance. Once the packages exist on npm, npm's trusted publishing can replace the token: configure this repository and `release.yml` as a trusted publisher on each of the four packages, then drop the secret. A trusted publisher can only be added to a package that already exists, so the first release still has to go out under the token.

The npm CLI version does not come into it: `changeset publish` shells out to `pnpm publish`, and since pnpm 12 that is pnpm's own implementation with trusted publishing built in, rather than a call through to npm. `pnpm/action-setup` has to be pinned at `v6.1.0` or newer for pnpm 12, because the `v6` tag still points at `v6.0.10`, which installs pnpm without running the postinstall that swaps the placeholder bin for the real binary.
