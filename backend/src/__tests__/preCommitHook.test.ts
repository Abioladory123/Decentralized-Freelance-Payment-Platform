import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pre-commit hook configuration tests (issue #300).
 *
 * Verifies that root package.json defines husky and lint-staged,
 * the .husky/pre-commit hook runs lint-staged, and staged configurations
 * exist for contracts and frontend.
 */

function repoRoot(): string {
  const cwd = process.cwd();
  const root = [cwd, path.resolve(cwd, "..")].find((dir) =>
    existsSync(path.join(dir, ".husky")),
  );
  if (!root) throw new Error(`repo root not found from ${cwd}`);
  return root;
}

describe("Pre-commit hook configuration (issue #300)", () => {
  it("defines husky and lint-staged in root package.json", () => {
    const root = repoRoot();
    const pkgPath = path.join(root, "package.json");
    expect(existsSync(pkgPath), "root package.json must exist").toBe(true);

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(pkg.devDependencies?.husky, "husky must be in devDependencies").toBeDefined();
    expect(pkg.devDependencies?.["lint-staged"], "lint-staged must be in devDependencies").toBeDefined();
    expect(pkg.scripts?.prepare, "scripts.prepare must run husky").toContain("husky");
  });

  it("configures lint-staged for contracts and frontend", () => {
    const root = repoRoot();
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const lintStaged = pkg["lint-staged"];
    expect(lintStaged, "lint-staged config must exist in package.json").toBeDefined();

    const rustPattern = Object.keys(lintStaged).find((k) => k.includes("contracts") && k.includes(".rs"));
    expect(rustPattern, "lint-staged must match contracts/**/*.rs").toBeDefined();
    expect(lintStaged[rustPattern!]).toContain("cargo fmt");

    const frontendPattern = Object.keys(lintStaged).find((k) => k.includes("frontend"));
    expect(frontendPattern, "lint-staged must match frontend files").toBeDefined();
    expect(lintStaged[frontendPattern!]).toContain("npm --prefix frontend run lint");
  });

  it("configures .husky/pre-commit to invoke lint-staged", () => {
    const root = repoRoot();
    const hookPath = path.join(root, ".husky", "pre-commit");
    expect(existsSync(hookPath), ".husky/pre-commit hook must exist").toBe(true);

    const content = readFileSync(hookPath, "utf8");
    expect(content).toMatch(/lint-staged/);
  });

  it("documents pre-commit hooks and --no-verify bypass in CONTRIBUTING.md", () => {
    const root = repoRoot();
    const contributing = readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8");

    expect(contributing).toMatch(/pre-commit/i);
    expect(contributing).toMatch(/--no-verify/);
  });
});
