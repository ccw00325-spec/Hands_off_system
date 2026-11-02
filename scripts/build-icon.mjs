// Format conversion of the user-approved PNG; no artwork is redrawn.
import { app, nativeImage } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
app.whenReady().then(async () => {
  try {
    const source = nativeImage.createFromPath(
      resolve("src/renderer/assets/mascot.png"),
    );
    if (source.isEmpty())
      throw new Error("Approved mascot PNG is missing or invalid.");
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const images = sizes.map((size) =>
      source.resize({ width: size, height: size, quality: "best" }).toPNG(),
    );
    const header = Buffer.alloc(6 + 16 * sizes.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    for (const [index, size] of sizes.entries()) {
      const start = 6 + index * 16;
      header[start] = size === 256 ? 0 : size;
      header[start + 1] = header[start];
      header.writeUInt16LE(1, start + 4);
      header.writeUInt16LE(32, start + 6);
      header.writeUInt32LE(images[index].length, start + 8);
      header.writeUInt32LE(offset, start + 12);
      offset += images[index].length;
    }
    await mkdir("build", { recursive: true });
    await writeFile("build/app.ico", Buffer.concat([header, ...images]));
    console.log(
      "Approved mascot converted to Windows ICO: 16, 24, 32, 48, 64, 128, 256px.",
    );
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  }
});
