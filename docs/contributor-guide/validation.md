# Local Validation

For validation architecture details, see [Architecture: Validation](./architecture/validation.md).

## 🎯 Quick Reference

### Validation Scripts

| Script | Purpose | Time | Use When |
|--------|---------|------|----------|
| `./.github/workflows/scripts/quick-check.sh` | Fast iteration check | ~30s | During development |
| `./.github/workflows/scripts/validate-locally.sh` | Full CI simulation | ~2-5min | Before pushing |
| `pnpm run pretest` | Pre-test setup | ~1min | Before running tests |
| `pnpm test` | All tests | ~2min | Verify functionality |

### Essential Commands

| Command | Purpose | When |
|---------|---------|------|
| `pnpm run lint` | Code style | During development |
| `pnpm run compile` | Build | Before testing |
| `pnpm run test:unit` | Unit tests | Fast feedback |
| `pnpm test` | All tests | Before pushing |
| `pnpm run package:full` | Production VSIX | Before release |

## 📋 Validation Workflow (Matches GitHub Actions)

### 1. **Security & Dependencies**
```bash
# Install dependencies with audit
pnpm install --frozen-lockfile
pnpm audit --prod --audit-level=moderate
```

### 2. **Code Quality**
```bash
# Linting
pnpm run lint

# Type checking & compilation
pnpm run compile
```

### 3. **Testing**
```bash
# Compile tests
pnpm run compile-tests

# Unit tests (fast)
pnpm run test:unit

# Integration tests (requires display)
pnpm run test:integration

# All tests
pnpm test
```

### 4. **Packaging**
```bash
# Full production package with optimizations
pnpm run package:full

# Or individual steps:
pnpm run package:prepare    # Switch to production config
pnpm run package:vsix        # Create VSIX
pnpm run package:cleanup     # Restore dev config
```

### 5. **Validation**
```bash
# Validate VSIX contents
unzip -l *.vsix

# Check package size
ls -lh *.vsix
```

## 🔧 Development Workflow

### For Quick Iterations (30 seconds)
```bash
./.github/workflows/scripts/quick-check.sh
```
Runs: `lint → compile → unit tests`

### Before Committing (2-5 minutes)
```bash
./.github/workflows/scripts/validate-locally.sh
```
Runs: Full CI simulation including packaging

### Continuous Development
```bash
# Terminal 1: Watch mode for auto-compilation
pnpm run watch

# Terminal 2: Watch mode for tests
pnpm run watch-tests
```

### Manual Quick Check
```bash
pnpm run lint && pnpm run compile && pnpm run test:unit
```

### Full Manual Validation
```bash
pnpm run lint
pnpm run compile
pnpm test
pnpm run package:full
```

## 📊 Understanding Test Organization

### Unit Tests (`test:unit`)
- Location: `test/{adapters,commands,services,utils}/`
- Fast, no VS Code API needed
- Mock dependencies
- **~30 seconds**

### Integration Tests (`test:integration`)
- Location: `test/integration/`
- Requires VS Code environment
- Tests real extension behavior
- **~1-2 minutes**

### Coverage Reports
```bash
# Unit test coverage
pnpm run test:coverage:unit

# Full coverage
pnpm run test:coverage

# View HTML report
open coverage/index.html
```

## 🎯 pnpm Script Cheatsheet

### Essential Commands
| Command | Description |
|---------|-------------|
| `pnpm run lint` | ESLint validation |
| `pnpm run compile` | Production build |
| `pnpm run watch` | Dev mode with auto-compile |
| `pnpm test` | Run all tests |
| `pnpm run test:unit` | Unit tests only |
| `pnpm run test:integration` | Integration tests |
| `pnpm run package:full` | Create production VSIX |

### Development Helpers
| Command | Description |
|---------|-------------|
| `pnpm run dev:setup` | Switch to dev-friendly config |
| `pnpm run compile-tests` | Compile test files |
| `pnpm run watch-tests` | Auto-compile tests |
| `pnpm run coverage:clean` | Clean coverage reports |

### Version Management
Run these from the repository root. Versions are bumped only by the release
workflow; see [Release Process](./releasing.md).

| Command | Description |
|---------|-------------|
| `pnpm run version:check` | Check that the packages and the extension share one version |
| `pnpm run test:scripts` | Test the version scripts |

## 🚨 Common Issues & Solutions

### Issue: Tests fail with "Cannot find module 'vscode'"
**Solution:**
```bash
pnpm run compile-tests
# Ensures test fixtures are copied
```

### Issue: Integration tests fail on Linux
**Solution:**
```bash
# Install required dependencies
sudo apt-get install -y xvfb libnss3-dev libatk-bridge2.0-dev

# Run with xvfb
xvfb-run -a pnpm run test:integration
```

### Issue: VSIX package too large
**Solution:**
```bash
# Use production packaging
pnpm run package:full

# This uses .vscodeignore.production which excludes:
# - Source files (src/, test/)
# - Dev dependencies
# - CI/CD files
# - Documentation
```

### Issue: audit warnings
**Solution:**
```bash
# Check what's failing
pnpm audit

# Fix automatically (if possible)
pnpm audit --fix

# Ignore dev dependencies
pnpm audit --prod
```

## 🎓 Workflow Examples

### Example 1: Fixing a Bug
```bash
# 1. Update source files in src/
# 2. Quick check
./.github/workflows/scripts/quick-check.sh

# 3. If passed, commit
git add .
git commit -m "fix: ..."
```

### Example 2: Adding a Feature
```bash
# 1. Create feature branch
git checkout -b feature/new-feature

# 2. Develop with watch mode
pnpm run watch        # Terminal 1
pnpm run watch-tests  # Terminal 2

# 3. Update test files
# 4. Full validation before push
./.github/workflows/scripts/validate-locally.sh

# 5. If passed, push
git push origin feature/new-feature
```

### Example 3: Pre-Release Checklist
```bash
# 1. Full validation
./.github/workflows/scripts/validate-locally.sh

# 2. Create production package
pnpm run package:full

# 3. Test the VSIX locally
code --install-extension *.vsix

# 4. Release: run the "Release AI Primitives Hub" workflow from main
#    (see docs/contributor-guide/releasing.md); it bumps the version and tags it
```

**Note:** Creating a GitHub release triggers automatic publication and should be done after proper validation. See [Release Process](./releasing.md) for publication workflow.

## 📦 Package Size Optimization

Production package should be **< 2MB**. If larger, check contents:

```bash
unzip -l *.vsix | grep extension/ | sort -k4 -rn | head -20
```

Common culprits: `node_modules/`, `src/`, `test/`, `.github/` (should be excluded)

## 🔍 Debugging Failed CI

When GitHub Actions fails:

1. Check which job failed in GitHub Actions UI
2. Reproduce locally: `./.github/workflows/scripts/validate-locally.sh`
3. Check specific step: `pnpm run lint`, `pnpm run test:unit`, or `pnpm run package:full`

## 💡 Pro Tips

- **Use watch mode** for faster feedback during development
- **Run quick-check.sh frequently** after changes and before switching branches
- **Run validate-locally.sh before pushing** to catch CI failures early
- **Keep test data small** for faster execution and easier debugging
- **Use coverage reports** to find untested code and guide testing efforts

## See Also

- [Development Setup](./development-setup.md)
- [Testing](./testing.md)
- [Golden Path Test Cases](./testing/golden-path.md)
- [Full Test Plan](./testing/test-plan.md)
- [Architecture: Validation](./architecture/validation.md)
