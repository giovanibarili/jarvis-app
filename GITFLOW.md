# GitFlow — JARVIS

## Branches

### Permanent
- **`main`** — production. Only receives merges from `release/*` and `hotfix/*`. Tagged on every merge.
- **`release/X.Y`** — active development branch for the upcoming release. All work starts here and returns here.

### Temporary
- **`feature/*`** — created from `release/X.Y`, PR back to `release/X.Y`
- **`dev/*`** — small changes, created from `release/X.Y`, PR back to `release/X.Y`
- **`hotfix/*`** — created from `main`, merged into `main` AND `release/X.Y`

## Weekly Release Cycle

Every **Tuesday**:

1. Finalize `release/X.Y` — ensure all PRs merged, tests green
2. Update `CHANGELOG.md` with all changes in the release
3. Update version in `version.json`, `app/package.json`, `packages/core/package.json`
4. Create PR: `release/X.Y` → `main`
5. Merge to `main`
6. Tag `main` with `vX.Y.0` (annotated tag)
7. Create new `release/X.(Y+1)` branch from `main`

## Versioning

Follows [Semantic Versioning](https://semver.org/):

- **Tuesday release**: bump minor or major (`0.2.0`, `0.3.0`, `1.0.0`)
- **Hotfix**: bump patch (`0.1.1`, `0.1.2`)

Version lives in three places (must stay in sync):
- `version.json` (root) — source of truth
- `app/package.json`
- `packages/core/package.json`

`@jarvis/core` follows the same version as JARVIS.

## Branch Naming

```
feature/short-description
feature/TICKET-ID/short-description
dev/short-description
hotfix/short-description
release/0.2
release/0.3
```

## Branch Protection

### `main`
- Require PR for all changes (no direct push)
- No force push
- Require status checks to pass (when CI is configured)

### `release/*`
- Require PR for all changes (no direct push)
- No force push

## Workflow Examples

### Feature Development
```
1. git checkout release/0.2
2. git checkout -b feature/my-feature
3. ... develop ...
4. PR: feature/my-feature → release/0.2
5. Merge PR
```

### Hotfix
```
1. git checkout main
2. git checkout -b hotfix/critical-bug
3. ... fix ...
4. PR: hotfix/critical-bug → main
5. Merge PR, tag vX.Y.Z
6. Cherry-pick or merge into release/X.Y
```

### Tuesday Release
```
1. Update CHANGELOG.md in release/X.Y
2. Bump version in version.json, app/package.json, packages/core/package.json
3. PR: release/X.Y → main
4. Merge PR
5. git tag -a vX.Y.0 -m "Release X.Y.0"
6. git push origin vX.Y.0
7. git checkout -b release/X.(Y+1) main
8. git push origin release/X.(Y+1)
```

## Changelog Format

Every release PR to `main` must include an updated `CHANGELOG.md`:

```markdown
## [X.Y.0] - YYYY-MM-DD

### Added
- New features

### Changed
- Modifications to existing features

### Fixed
- Bug fixes

### Removed
- Removed features
```
