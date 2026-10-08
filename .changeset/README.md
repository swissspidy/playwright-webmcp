# Changesets

This repository uses [changesets](https://github.com/changesets/changesets) to version and publish the packages.

- Run `pnpm changeset` in a pull request that changes a published package and pick a bump. The four packages are versioned together, so one changeset covers all of them.
- When changesets land on `main`, the release workflow opens a "Version Packages" pull request that bumps versions and updates `CHANGELOG.md` files.
- Merging that pull request publishes to npm with provenance.

## Before the first release

The four packages sit at `0.0.0` in the repository. Nothing is published yet, and changesets computes the next version from the one it finds in the manifest, so the placeholder decides what the first release is called: the `minor` in `initial-release.md` takes `0.0.0` to `0.1.0`, where it would have taken a declared `0.1.0` to `0.2.0` and skipped the number entirely. `0.0.0` is never published — it only exists so the first "Version Packages" pull request lands on `0.1.0`.

Once that release is out, this stops mattering: every version after it is computed from the last published one, and the manifests hold real versions.

## What the release workflow needs

- Each of the four packages on npm lists this repository and `release.yml` as its trusted publisher. npm accepts the publishing job's OIDC token instead of a stored token, and adds provenance.
- "Allow GitHub Actions to create and approve pull requests" enabled under Settings → Actions → General, so the action can open the "Version Packages" pull request.

## How the release workflow runs

It has three jobs, so that the only job that can publish installs and runs nothing from the dependency tree:

1. `version` runs on every push to `main`. Changesets opens or updates the "Version Packages" pull request; it installs with `--ignore-scripts` and has no OIDC token. When `main`'s packages carry versions npm does not have yet (that pull request was merged), the push is a release.
2. `pack` builds the packages, runs publint and packs each one with `pnpm pack`, which rewrites `workspace:` ranges to the released versions. It has no OIDC token either.
3. `publish` is the only job with `id-token: write`. It installs nothing: it publishes the tarballs with `npm publish` (npm 11.5.1 or later, which the job checks), then tags each `name@version` and creates its GitHub release from the package's `CHANGELOG.md`, as `changeset publish` did. Versions already on npm and existing tags are skipped, so a run that failed partway can be re-run.

Provenance also comes from `publishConfig.provenance` in each package, which `npm publish` reads from the tarball's manifest.
