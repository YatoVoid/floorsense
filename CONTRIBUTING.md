# Contributing

## Requirements

Node.js 26.4.0 or newer. This repo relies on the built-in `node:sqlite`
module and Node's native TypeScript execution, no build step, no `ts-node`.

## Running it

```bash
npm install
npm test
```

Installs all 6 workspace packages and runs the full test suite, around 240
tests. See the README's "Try it" section for starting the owner dashboard
directly.

## Before opening a PR

```bash
npm run build --workspaces --if-present
npm run test --workspaces --if-present
```

Both should pass across all workspace packages, not just the one you
touched, since the packages share the salted-hash device model.

- Never store a raw MAC address, only the salted hash. If a change makes
  raw device identifiers reachable anywhere, including logs, that's a
  blocker, not a nitpick.
- This is a local-first proof of concept. Don't add a hosted backend or a
  telemetry call as a dependency of core functionality.

## Reporting a bug

Which package (backend, owner-portal, or another workspace), what you did,
what you expected, and what happened. Include Node version.
