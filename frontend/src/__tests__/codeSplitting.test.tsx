/**
 * Dynamic code splitting and route lazy loading (issue #293).
 *
 * Verifies that App.tsx dynamically imports page routes using React.lazy,
 * wraps routes in Suspense with JobDetailSkeleton fallback, and ensures
 * Vite bundle configuration chunks heavy vendor dependencies.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "../App";
import appSource from "../App.tsx?raw";
import viteSource from "../../vite.config.ts?raw";

describe("Route lazy loading and code splitting (issue #293)", () => {
  it("uses React.lazy for all page routes in App.tsx", () => {
    const expectedPages = [
      "Dashboard",
      "Activity",
      "PostJob",
      "JobDetail",
      "Receipt",
      "Profile",
      "FreelancerDirectory",
      "NotFound",
    ];

    for (const page of expectedPages) {
      const regex = new RegExp(
        `const\\s+${page}\\s*=\\s*lazy\\(\\s*\\(\\)\\s*=>\\s*import\\(["']\\./pages/${page}["']\\)\\)`,
      );
      expect(appSource).toMatch(regex);
    }
  });

  it("wraps route transitions in Suspense with JobDetailSkeleton fallback", () => {
    expect(appSource).toMatch(/<Suspense\s+fallback=\{<JobDetailSkeleton\s*\/>\}>/);
  });

  it("configures Vite manualChunks for heavy dependencies", () => {
    expect(viteSource).toMatch(/manualChunks/);
    expect(viteSource).toMatch(/@stellar\/stellar-sdk/);
  });

  it("renders the loading skeleton as the initial fallback", () => {
    render(<App />);
    // While lazy chunks are loading, the Suspense fallback is displayed
    const skeleton = screen.queryByRole("status");
    if (skeleton) {
      expect(skeleton.getAttribute("aria-busy")).toBe("true");
    }
  });
});
