import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Database migration decoupling (issue #302):
 * Web container startup must not run database migrations. Migrations must run
 * in a dedicated pre-deploy step on Render and via an init container in docker compose.
 */

function repoFile(...segments: string[]): string {
  const cwd = process.cwd();
  const root = [cwd, path.resolve(cwd, "..")].find((dir) =>
    existsSync(path.join(dir, "docker-compose.yml")),
  );
  if (!root) throw new Error(`repo root not found from ${cwd}`);
  return readFileSync(path.join(root, ...segments), "utf8").replace(/\r/g, "");
}

describe("backend/Dockerfile migration separation (issue #302)", () => {
  it("executes only the server process in CMD without running migrations on startup", () => {
    const dockerfile = repoFile("backend", "Dockerfile");
    const cmdMatch = /^CMD\s+(.*)$/m.exec(dockerfile);
    expect(cmdMatch, "backend/Dockerfile must declare a CMD instruction").not.toBeNull();
    const cmd = cmdMatch![1];
    expect(cmd).toContain('"node"');
    expect(cmd).toContain('"dist/server.js"');
    expect(cmd).not.toContain("prisma migrate deploy");
  });
});

describe("render.yaml preDeployCommand (issue #302)", () => {
  it("configures preDeployCommand for schema migrations", () => {
    const renderYaml = repoFile("render.yaml");
    expect(renderYaml).toMatch(/preDeployCommand:\s*npx prisma migrate deploy/);
  });
});

describe("docker-compose.yml migration service (issue #302)", () => {
  it("declares a migration service that executes prisma migrate deploy", () => {
    const compose = repoFile("docker-compose.yml");
    expect(compose).toMatch(/migration:\s*\n\s+build:/);
    expect(compose).toContain('["npx", "prisma", "migrate", "deploy"]');
  });

  it("configures backend service to wait for migration service completion", () => {
    const compose = repoFile("docker-compose.yml");
    expect(compose).toMatch(/migration:\s*\n\s+condition:\s*service_completed_successfully/);
  });
});
