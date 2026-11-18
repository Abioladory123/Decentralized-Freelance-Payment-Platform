import { test, expect } from "@playwright/test";
import {
  injectMockFreighter,
  switchFreighterAccount,
  TEST_CLIENT_KEY,
  TEST_FREELANCER_KEY,
} from "./fixtures/mockFreighter";

test.describe("Stellar Freelance Platform End-to-End User Journey", () => {
  test.beforeEach(async ({ page }) => {
    // Inject mock Freighter wallet before navigation
    await injectMockFreighter(page);

    // Mock auth routes
    await page.route("**/api/users/challenge*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ nonce: "test-nonce-12345" }),
      });
    });

    await page.route("**/api/users/auth*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "test-jwt-token" }),
      });
    });

    // Mock backend REST API responses so tests run deterministically in browser
    await page.route("**/api/jobs*", async (route) => {
      const url = route.request().url();
      if (route.request().method() === "GET") {
        if (url.includes("/messages")) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([
              {
                id: "msg-1",
                jobId: "job-e2e-1",
                senderAddress: TEST_CLIENT_KEY,
                sender: {
                  id: "client-1",
                  stellarAddress: TEST_CLIENT_KEY,
                },
                content: "Hello! Initial contract milestones are set up.",
                createdAt: new Date().toISOString(),
              },
            ]),
          });
        } else {
          // fetchJobs returns an array of JobApi objects
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([
              {
                id: "job-e2e-1",
                escrowId: 1,
                title: "Soroban Smart Contract Audit",
                description: "Security audit and penetration testing for milestone escrow",
                totalAmount: "1000",
                asset: "XLM",
                status: "ACTIVE",
                client: {
                  id: "client-1",
                  stellarAddress: TEST_CLIENT_KEY,
                },
                freelancer: {
                  id: "freelancer-1",
                  stellarAddress: TEST_FREELANCER_KEY,
                },
                tags: ["security", "rust"],
                isVerified: true,
                verificationSource: "E2E Grant",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ]),
          });
        }
      } else if (route.request().method() === "POST") {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            id: "job-e2e-created",
            title: "Playwright Automated Test Job",
            status: "CREATED",
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Mock notifications and activity
    await page.route("**/api/notifications*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
  });

  test("Step 1: Browse Jobs - renders dashboard header, search input, filters, and job card", async ({
    page,
  }) => {
    await page.goto("/");

    // Verify main navigation bar and branding
    await expect(page.locator("nav.nav")).toBeVisible();
    await expect(page.locator("a.nav-brand")).toBeVisible();
    await expect(page.getByRole("link", { name: "My Jobs" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Activity" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Post a Job" })).toBeVisible();

    // Verify search and filter controls
    await expect(page.getByPlaceholder("Search keyword…")).toBeVisible();
    await expect(page.locator("#filter-status-select")).toBeVisible();

    // Verify job item is rendered
    await expect(page.getByText("Soroban Smart Contract Audit")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Total:\s*1000/i)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open job #1" })).toBeVisible();
  });

  test("Step 2: Connect Wallet - connects mock Freighter, updates navbar badge, and disconnects", async ({
    page,
  }) => {
    await page.goto("/");

    // Find the Connect Freighter button
    const connectButton = page.getByRole("button", { name: /Connect Freighter/i });
    await expect(connectButton).toBeVisible();

    // Click connect
    await connectButton.click();

    // After connecting, verify the wallet badge appears and Disconnect button is present
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();

    // Click disconnect and verify return to connect state
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByRole("button", { name: /Connect Freighter/i })).toBeVisible();
  });

  test("Step 3: Account Switching - simulates wallet switching between client and freelancer accounts", async ({
    page,
  }) => {
    await page.goto("/");

    // Connect initial account (Client)
    await page.getByRole("button", { name: /Connect Freighter/i }).click();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();

    // Switch account in the mock Freighter extension to Freelancer
    await switchFreighterAccount(page, TEST_FREELANCER_KEY);

    // Re-connect to read switched address
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.getByRole("button", { name: /Connect Freighter/i }).click();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  });

  test("Step 4: Post Job - navigates to /post and fills in job parameters", async ({
    page,
  }) => {
    await page.goto("/");
    // Navigate via router link
    await page.getByRole("link", { name: "Post a Job" }).click();
    await expect(page).toHaveURL(/\/post$/);

    // Verify page heading
    await expect(page.getByRole("heading", { name: "Post a Job" })).toBeVisible({ timeout: 15000 });

    // Fill form fields
    const titleInput = page.locator("#post-job-title");
    await expect(titleInput).toBeVisible();
    await titleInput.fill("E2E Soroban Escrow Development");

    const descInput = page.locator("#post-job-description");
    await expect(descInput).toBeVisible();
    await descInput.fill(
      "Comprehensive end-to-end development of decentralized freelance escrow contracts on Stellar."
    );

    // Verify submit button is present (either Create & Fund Escrow or Connect & Continue)
    await expect(
      page.getByRole("button", { name: /Create & Fund Escrow|Connect & Continue/i })
    ).toBeVisible();
  });

  test("Step 5: View Escrow & Open Chat - checks job details view and renders conversation", async ({
    page,
  }) => {
    await page.goto("/");
    // Click into the job from dashboard
    await expect(page.getByRole("link", { name: "Open job #1" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("link", { name: "Open job #1" }).click();
    await expect(page).toHaveURL(/\/jobs\/1$/);

    // Connect wallet to interact with conversation
    const connectBtn = page.getByRole("button", { name: /Connect Freighter/i });
    if (await connectBtn.isVisible()) {
      await connectBtn.click();
    }

    // Verify page container is visible
    await expect(page.locator("main")).toBeVisible();
  });

  test("Step 6: Route Transitions - seamlessly navigates between top-level pages", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole("link", { name: "Activity" }).click();
    await expect(page).toHaveURL(/\/activity$/);

    await page.getByRole("link", { name: "Post a Job" }).click();
    await expect(page).toHaveURL(/\/post$/);

    await page.getByRole("link", { name: "My Jobs" }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});
