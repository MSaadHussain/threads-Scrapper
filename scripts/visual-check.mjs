import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("console", (message) => console.log(`[browser:${message.type()}] ${message.text()}`));
page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
console.log(`Visible panels: ${await page.locator(".view.is-visible").count()}`);
console.log(`Command cards: ${await page.locator(".command-card").count()}`);
await page.screenshot({ path: "dashboard-desktop.png", fullPage: true });
await page.getByRole("button", { name: /^Leads/ }).click();
await page.waitForTimeout(350);
console.log(`Intent badges: ${await page.locator(".intent-state").count()}`);
console.log(`Intent filters: ${await page.locator("#lead-intent-filter option").count()}`);
console.log(`Delete-all controls: ${await page.locator("#delete-all-leads").count()}`);
await page.screenshot({ path: "dashboard-leads.png", fullPage: true });
await page.getByRole("button", { name: "Deliveries" }).click();
await page.waitForTimeout(350);
console.log(`Delivery channels: ${await page.locator(".channel-card").count()}`);
console.log(`Buyer-only rules: ${await page.locator(".locked-rule").count()}`);
await page.screenshot({ path: "dashboard-deliveries.png", fullPage: true });
await page.getByRole("button", { name: "Radar" }).click();
const sessionButton = page.getByRole("button", { name: /Connect Threads|Check connection/ });
if ((await sessionButton.textContent()).includes("Connect Threads")) {
  await sessionButton.click();
  console.log(`Login modal open: ${await page.locator("#auth-modal:not([hidden])").count()}`);
  await page.locator("#auth-modal [data-close-modal]").click();
} else {
  console.log("Login modal skipped: Threads is already connected");
}
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
console.log(`Mobile body class: ${await page.locator("body").getAttribute("class")}`);
console.log(`Mobile sidebar transform: ${await page.locator(".sidebar").evaluate((node) => getComputedStyle(node).transform)}`);
await page.screenshot({ path: "dashboard-mobile.png", fullPage: false });
await page.getByRole("button", { name: "Open navigation" }).click();
await page.waitForTimeout(300);
console.log(`Mobile menu transform: ${await page.locator(".sidebar").evaluate((node) => getComputedStyle(node).transform)}`);
await browser.close();
