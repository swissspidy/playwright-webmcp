# Changesets

This repository uses [changesets](https://github.com/changesets/changesets) to version and publish the packages.

- Run `pnpm changeset` in a pull request that changes a published package and pick a bump. The four packages are versioned together, so one changeset covers all of them.
- When changesets land on `main`, the release workflow opens a "Version Packages" pull request that bumps versions and updates `CHANGELOG.md` files.
- Merging that pull request publishes to npm with provenance.

## Before the first release

The four packages sit at `0.0.0` in the repository. Nothing is published yet, and changesets computes the next version from the one it finds in the manifest, so the placeholder decides what the first release is called: the `minor` in `initial-release.md` takes `0.0.0` to `0.1.0`, where it would have taken a declared `0.1.0` to `0.2.0` and skipped the number entirely. `0.0.0` is never published — it only exists so the first "Version Packages" pull request lands on `0.1.0`.

Once that release is out, this stops mattering: every version after it is computed from the last published one, and the manifests hold real versions.

## What the release workflow needs

- An `NPM_TOKEN` repository secret: a granular npm access token with read and write permission for the four packages (or, before the first publish, for new packages under the account and the `@swissspidy` scope), with two-factor bypass enabled so it can publish unattended. The workflow exposes it only to the publish step, through `pnpm_config__auth`, which carries the registry URL and the token together.
- "Allow GitHub Actions to create and approve pull requests" enabled under Settings → Actions → General, so the action can open the "Version Packages" pull request.

Publishing already runs with `id-token: write` and provenance. Once the packages exist on npm, npm's trusted publishing can replace the token: configure this repository and `release.yml` as a trusted publisher on each of the four packages, then drop the secret. A trusted publisher can only be added to a package that already exists, so the first release still has to go out under the token.

The npm CLI version does not come into it: `changeset publish` shells out to `pnpm publish`, and since pnpm 12 that is pnpm's own implementation with trusted publishing built in, rather than a call through to npm. Nothing writes an `.npmrc` either, so switching to trusted publishing means deleting the `pnpm_config__auth` block rather than replacing it with another secret.

Provenance comes from `publishConfig.provenance` in each package. pnpm reads `pnpm_config_*` environment variables and ignores npm's `npm_config_*`, so an `NPM_CONFIG_PROVENANCE` on the publish step would do nothing.
