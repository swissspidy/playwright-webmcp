# Changesets

This repository uses [changesets](https://github.com/changesets/changesets) to version and publish the packages.

- Run `pnpm changeset` in a pull request that changes a published package and pick a bump. The four packages are versioned together, so one changeset covers all of them.
- When changesets land on `main`, the release workflow opens a "Version Packages" pull request that bumps versions and updates `CHANGELOG.md` files.
- Merging that pull request publishes to npm with provenance.
