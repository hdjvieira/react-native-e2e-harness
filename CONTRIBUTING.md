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

## Code style

TypeScript, ESM, Prettier with no semicolons, single quotes and trailing commas. `yarn format` fixes formatting.
