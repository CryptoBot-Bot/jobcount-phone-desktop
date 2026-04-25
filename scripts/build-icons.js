#!/usr/bin/env node
// scripts/build-icons.js
//
// Convert assets/icon.svg → assets/icon.png and assets/icon.ico so
// electron-builder has the raster files it needs at packaging time.
//
// Runs as a `prebuild`/`prerelease` hook (see package.json scripts).
// Idempotent — re-runs are cheap; the SVG is the source of truth.

"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pngToIco = require("png-to-ico");

const ROOT = path.resolve(__dirname, "..");
const SVG = path.join(ROOT, "assets", "icon.svg");
const PNG = path.join(ROOT, "assets", "icon.png");
const ICO = path.join(ROOT, "assets", "icon.ico");

async function main() {
  if (!fs.existsSync(SVG)) {
    console.error("[build-icons] missing source:", SVG);
    process.exit(1);
  }
  const svg = fs.readFileSync(SVG);

  // 512×512 master PNG (electron-builder uses this on Linux + falls
  // back to it on Windows when no .ico is present, but we ship an
  // .ico explicitly below for crisp Windows rendering).
  console.log("[build-icons] rendering icon.png (512×512)…");
  await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(PNG);

  // Multi-size .ico (Windows Explorer renders different sizes at
  // different zoom levels — bundling 16/24/32/48/64/128/256 covers
  // every common case). png-to-ico needs raw PNG buffers per size.
  console.log("[build-icons] rendering icon.ico (multi-size)…");
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = [];
  for (const size of sizes) {
    const buf = await sharp(svg, { density: Math.max(96, size * 4) })
      .resize(size, size)
      .png()
      .toBuffer();
    buffers.push(buf);
  }
  const ico = await pngToIco(buffers);
  fs.writeFileSync(ICO, ico);

  console.log("[build-icons] done.");
  console.log("  ", PNG, fs.statSync(PNG).size, "bytes");
  console.log("  ", ICO, fs.statSync(ICO).size, "bytes");
}

main().catch((e) => {
  console.error("[build-icons] failed:", e);
  process.exit(1);
});
