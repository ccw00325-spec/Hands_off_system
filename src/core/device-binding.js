import { hostname, userInfo, homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
let cached;
export function deviceBinding() {
  if (cached) return cached;
  cached = (async () => {
    let machine = "";
    if (process.platform === "win32")
      machine = await new Promise((resolve) => {
        const child = spawn(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"),
          [
            "query",
            "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
            "/v",
            "MachineGuid",
          ],
          {
            windowsHide: true,
            shell: false,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        let value = "";
        const timer = setTimeout(() => {
          child.kill();
          resolve("");
        }, 3000);
        child.stdout.on("data", (chunk) => {
          value += chunk;
        });
        child.once("error", () => {
          clearTimeout(timer);
          resolve("");
        });
        child.once("close", () => {
          clearTimeout(timer);
          resolve(value.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1] ?? "");
        });
      });
    return createHash("sha256")
      .update(
        JSON.stringify([
          process.platform,
          hostname(),
          userInfo().username,
          homedir(),
          machine,
        ]),
      )
      .digest("hex");
  })();
  return cached;
}
