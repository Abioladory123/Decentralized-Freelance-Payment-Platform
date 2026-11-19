import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Nav } from "../App";

// Mock wallet context
const mockWallet = {
  publicKey: null as string | null,
  connecting: false,
  networkMismatch: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
  signMessage: vi.fn(),
  error: null,
};

vi.mock("../hooks/wallet-context", () => ({
  useWallet: () => mockWallet,
}));

describe("Nav component (Issue #251)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders Freelancers directory link between Activity and Post a Job", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Nav />
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", { name: /main navigation/i });
    expect(nav).toBeDefined();

    const links = screen.getAllByRole("link");
    const linkTexts = links.map((l) => l.textContent?.trim());

    // Navigation links should include Brand, My Jobs, Activity, Freelancers, Post a Job
    expect(linkTexts).toContain("My Jobs");
    expect(linkTexts).toContain("Activity");
    expect(linkTexts).toContain("Freelancers");
    expect(linkTexts).toContain("Post a Job");

    const activityIdx = linkTexts.indexOf("Activity");
    const freelancersIdx = linkTexts.indexOf("Freelancers");
    const postJobIdx = linkTexts.indexOf("Post a Job");

    expect(freelancersIdx).toBeGreaterThan(activityIdx);
    expect(postJobIdx).toBeGreaterThan(freelancersIdx);

    const freelancersLink = screen.getByRole("link", { name: "Freelancers" });
    expect(freelancersLink.getAttribute("href")).toBe("/freelancers");
  });

  it("highlights the active route with active class and aria-current", () => {
    render(
      <MemoryRouter initialEntries={["/freelancers"]}>
        <Nav />
      </MemoryRouter>,
    );

    const freelancersLink = screen.getByRole("link", { name: "Freelancers" });
    expect(freelancersLink.classList.contains("active")).toBe(true);
    expect(freelancersLink.getAttribute("aria-current")).toBe("page");

    const myJobsLink = screen.getByRole("link", { name: "My Jobs" });
    expect(myJobsLink.classList.contains("active")).toBe(false);
  });

  it("navigates to /freelancers when Freelancers link is clicked", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Nav />
      </MemoryRouter>,
    );

    const freelancersLink = screen.getByRole("link", { name: "Freelancers" });
    expect(freelancersLink.classList.contains("active")).toBe(false);

    fireEvent.click(freelancersLink);
    expect(freelancersLink.classList.contains("active")).toBe(true);
    expect(freelancersLink.getAttribute("aria-current")).toBe("page");
  });
});
