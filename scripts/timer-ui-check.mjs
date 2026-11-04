import { _electron as electron } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
export async function verifyTimerUI(root, profileRoot = root) {
  const harness = resolve("artifacts/timer-ui-harness.cjs");
  await mkdir(resolve("artifacts"), { recursive: true });
  await writeFile(
    harness,
    `const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(process.argv[2],'.timer-test-profile'));app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.loadURL('about:blank');});app.on('window-all-closed',()=>app.quit());`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({
    args: [harness, profileRoot],
    cwd: resolve("."),
    env,
  });
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(10000);
    await page.waitForLoadState("load");
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.goto(pathToFileURL(join(root, "index.html")).href);
    await page.clock.pauseAt(new Date("2026-01-01T00:00:10Z"));
    await page.locator("#duration-input").fill("3");
    await page.locator("#start-button").click();
    assert.equal(
      await page.locator("#status-display").getAttribute("data-status"),
      "running",
    );
    await page.clock.runFor(1100);
    assert.match(await page.locator("#time-display").innerText(), /00:02/);
    await page.locator("#pause-button").click();
    const frozen = await page.locator("#time-display").innerText();
    await page.clock.runFor(2000);
    assert.equal(await page.locator("#time-display").innerText(), frozen);
    assert.equal(
      await page.locator("#status-display").getAttribute("data-status"),
      "paused",
    );
    await page.locator("#start-button").click();
    await page.clock.runFor(3000);
    assert.equal(
      await page.locator("#status-display").getAttribute("data-status"),
      "completed",
    );
    assert.match(await page.locator("#time-display").innerText(), /00:00/);
    await page.locator("#reset-button").click();
    assert.match(await page.locator("#time-display").innerText(), /00:03/);
    assert.equal(
      await page.locator("#status-display").getAttribute("data-status"),
      "idle",
    );
    await page.locator("#duration-input").fill("0");
    if (await page.locator("#start-button").isEnabled())
      await page.locator("#start-button").click();
    assert.notEqual(
      await page.locator("#status-display").getAttribute("data-status"),
      "running",
    );
    assert.ok((await page.locator("#error-message").innerText()).trim());
    await page.locator("#duration-input").fill("60");
    await page.locator("#reset-button").click();
    await page.screenshot({ path: resolve("artifacts", "timer-live-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve("artifacts", "timer-live-mobile.png"), fullPage: true });
    return "real Electron timer UI: start, pause, resume, completion, reset, invalid input passed";
  } finally {
    await application.close();
  }
}
