Added the release and publish workflows, following the pattern used across the
other MetalBear repositories: changelog fragments drive a scheduled release PR,
and merging that PR publishes to npm and cuts a GitHub release. The package is
published as `@metalbear/mirrord-sdk` and authenticates through npm trusted
publishing, so the repository holds no npm token.
