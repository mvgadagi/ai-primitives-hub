# Project Scripts

This directory contains utility scripts for managing the AI Primitives Hub project.

## 📋 Table of Contents

- [Test Scripts](#test-scripts)
- [Package Helpers](#package-helpers)

The extension's version is not bumped here: it shares one version with the
npm packages and is released by the repository release workflow. See
[Release Process](../../../docs/contributor-guide/releasing.md).

---

## Test Scripts

### `run-single-test.js`

Helper script to run a single test file with automatic TypeScript to JavaScript path conversion.

#### Features

- ✅ Accepts TypeScript file paths (`.ts`) directly
- ✅ Automatically converts to compiled JavaScript paths
- ✅ Smart compilation: Only recompiles if needed
- ✅ Skip compilation with `--no-compile` flag for faster execution
- ✅ Works with both unit and integration tests

#### Usage

**Run a single test (auto-compiles if needed):**
```bash
npm run test:one -- test/path/to/file.test.ts
```

**Run without recompiling (faster if tests are already compiled):**
```bash
npm run test:one -- test/path/to/file.test.ts --no-compile
```

#### How It Works

1. Takes TypeScript test path: `test/commands/MyTest.test.ts`
2. Converts to compiled path: `test-dist/test/commands/MyTest.test.js`
3. Checks if compilation is needed (file missing or outdated)
4. Compiles if needed (unless `--no-compile` is used)
5. Runs the test with Mocha

#### Examples

```bash
# Unit test
npm run test:one -- test/services/AutoUpdateService.test.ts

# Integration test
npm run test:one -- test/commands/BundleCommands.autoUpdate.integration.test.ts

# Skip compilation for speed (tests already compiled)
npm run test:one -- test/utils/configTypeGuards.test.ts --no-compile

# With error-only logging
LOG_LEVEL=ERROR npm run test:one -- test/services/RegistryManager.test.ts
```

#### Troubleshooting

**Test file not found:**
- Ensure the path starts with `test/` and ends with `.test.ts`
- Check that the file exists in the test directory

**Compilation errors:**
- Run `npm run compile-tests` manually to see detailed errors
- Check TypeScript syntax in your test file

**Test fails to run:**
- Verify the compiled file exists in `test-dist/test/`
- Try running with full compilation: remove `--no-compile` flag

---

## Package Helpers

### `package-helpers.js`

Manages file exclusions for development vs production builds.

#### Usage

```bash
# Show current exclusion status
npm run ignore:status

# Switch to development mode (Copilot-friendly)
npm run ignore:dev

# Switch to production mode (smaller package)
npm run ignore:prod

# Restore original .vscodeignore
npm run ignore:restore
```

---

## Contributing

When adding new scripts:

1. Add proper shebang (`#!/usr/bin/env bash` or `#!/usr/bin/env node`)
2. Make executable: `chmod +x scripts/your-script.sh`
3. Add comprehensive help text (use `--help` flag)
4. Follow existing naming conventions
5. Add error handling and validation
6. Update this README with documentation
7. Add corresponding npm script in package.json

---

## Best Practices

### Script Development

- **Use `set -euo pipefail`** in bash scripts for safety
- **Validate inputs** before making changes
- **Create backups** before modifying files
- **Provide colorized output** for better UX
- **Return proper exit codes** (0 for success, non-zero for errors)
- **Document all options** in script header comments

### Naming Conventions

- Use kebab-case: `run-single-test.js`
- Use descriptive names that indicate purpose
- Group related scripts with common prefixes

### Testing Scripts

Before committing:

1. Test with valid inputs
2. Test with invalid inputs
3. Test edge cases (empty files, missing files, etc.)
4. Test on different platforms (Linux, macOS, Windows via Git Bash)
5. Verify npm script integration works

---

## License

Apache License 2.0 - See [LICENSE](../LICENSE.txt) for details.
