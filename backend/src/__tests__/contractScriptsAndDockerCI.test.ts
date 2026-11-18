import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows Contract Test Scripts & Docker CI Verification (Issues #283 & #284)", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const scriptsDir = path.join(repoRoot, "scripts");
  const contractsDir = path.join(repoRoot, "contracts");
  const ciWorkflowPath = path.join(repoRoot, ".github/workflows/ci.yml");
  const contributingPath = path.join(repoRoot, "CONTRIBUTING.md");
  const contractsReadmePath = path.join(contractsDir, "README.md");

  describe("Windows Contract Testing Helpers (Issue #283)", () => {
    it("scripts/test_contracts_docker.sh exists and mounts contracts into rust:1.80 container", () => {
      const shPath = path.join(scriptsDir, "test_contracts_docker.sh");
      expect(existsSync(shPath)).toBe(true);
      const content = readFileSync(shPath, "utf8");
      expect(content).toContain("docker run");
      expect(content).toContain("rust:1.80");
      expect(content).toContain("cargo test");
      expect(content).toContain("export ordinal too large");
    });

    it("scripts/test_contracts_docker.bat exists for native Windows Command Prompt execution", () => {
      const batPath = path.join(scriptsDir, "test_contracts_docker.bat");
      expect(existsSync(batPath)).toBe(true);
      const content = readFileSync(batPath, "utf8");
      expect(content).toContain("docker run");
      expect(content).toContain("rust:1.80");
      expect(content).toContain("cargo test");
    });

    it("scripts/test_contracts.sh delegates to Docker runner on Windows environments", () => {
      const shPath = path.join(scriptsDir, "test_contracts.sh");
      expect(existsSync(shPath)).toBe(true);
      const content = readFileSync(shPath, "utf8");
      expect(content).toContain("test_contracts_docker.sh");
      expect(content).toContain("cargo test");
    });

    it("CONTRIBUTING.md and contracts/README.md document the PE/COFF linker limitation and solutions", () => {
      expect(existsSync(contributingPath)).toBe(true);
      const contributing = readFileSync(contributingPath, "utf8");
      expect(contributing).toContain("ld: error: export ordinal too large: 73648");
      expect(contributing).toContain("PE/COFF");
      expect(contributing).toContain("test_contracts_docker.sh");

      expect(existsSync(contractsReadmePath)).toBe(true);
      const contractsReadme = readFileSync(contractsReadmePath, "utf8");
      expect(contractsReadme).toContain("ld: error: export ordinal too large: 73648");
      expect(contractsReadme).toContain("PE/COFF");
      expect(contractsReadme).toContain("test_contracts_docker.sh");
      expect(contractsReadme).toContain("WSL2");
    });
  });

  describe("Automated Docker Build in CI (Issue #284)", () => {
    it(".github/workflows/ci.yml includes docker build job for backend and frontend", () => {
      expect(existsSync(ciWorkflowPath)).toBe(true);
      const content = readFileSync(ciWorkflowPath, "utf8");

      expect(content).toMatch(/docker:\s*\n\s*name:.*Docker/);
      expect(content).toContain("docker/setup-buildx-action");
      expect(content).toContain("docker/build-push-action");
      expect(content).toContain("backend/Dockerfile");
      expect(content).toContain("frontend/Dockerfile");
      expect(content).toContain("push: false");
      expect(content).toContain("cache-from: type=gha");
      expect(content).toContain("cache-to: type=gha,mode=max");
    });
  });
});
