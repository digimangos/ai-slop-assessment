# Contributing

Contributions and constructive feedback are welcome. For substantial changes,
open an issue first to discuss the approach. For vulnerabilities, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## Proposing a change

1. Create a branch from the latest `main`.
2. Make a focused change and add tests for any new or corrected behaviour.
3. Run the checks below and update documentation when behaviour or setup changes.
4. Open a pull request describing the change, its validation and any limitations.

Please follow the [code of conduct](CODE_OF_CONDUCT.md) and do not include
credentials, private source code or sensitive logs in issues or pull requests.

## Development

Use Node.js 24 and run:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run format:check
```

For changes to agentic workflow sources, regenerate and commit the corresponding
lock files using the pinned compiler commands in the [README](README.md#development).
Do not edit generated lock files by hand. The offline checks do not require a
Copilot token; real model runs can incur usage.

Keep pull-request content untrusted: privileged workflows must not check out or
execute proposed PR code. Preserve source-evidence validation and the separation
between model analysis and publication.
