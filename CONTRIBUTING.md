# Contributing

Thanks for helping. The short version:

1. Open an issue first for anything bigger than a small fix, so we agree on the shape before you write it.
2. Fork, branch from `main`, and keep the change focused.
3. Run `yarn verify` before you push.
4. Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/) (`feat: …`, `fix: …`). Releases and the changelog are generated from them.
5. Open a pull request against `main` and fill in the template.

Pull requests are reviewed with help from an AI assistant. The maintainer merges.

## Keep it generic

The harness has to work for any React Native app. Nothing specific to one app (ids, accounts, hosts, product names) goes into the package; it belongs in the app's own config or helpers.

## The example app

`example/` is a small React Native app the harness tests itself against: the **Example app on an emulator** workflow builds it and runs `example/e2e/specs` on an Android emulator for every change to the package. A change that affects how the harness drives an app should come with a spec there. To run it locally: install the debug build on an emulator (`yarn workspace e2e-example android`), then `yarn workspace e2e-example e2e run`.

## Code style

TypeScript, ESM, Prettier with no semicolons, single quotes and trailing commas. `yarn format` fixes formatting.

## Releases

A release is a pull request that sets the new `version` in `packages/harness/package.json` (semver: a breaking change to the config, a helper or the CLI is a new major), then, once merged, a tag on `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`. The **Release** workflow publishes it to npm.
