import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";

function dimensions(file: string): [number, number] {
  const png = readFileSync(new URL(`../public/${file}`, import.meta.url));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

test("the supplied logo and all app icon sizes are committed PNGs", () => {
  const [width, height] = dimensions("logo.png");
  assert.equal(width, height);
  assert.ok(width >= 512);
  for (const [file, size] of [
    ["favicon.png", 32], ["favicon-16.png", 16], ["apple-touch-icon.png", 180],
    ["icon-192.png", 192], ["icon-512.png", 512], ["icon-maskable-512.png", 512],
  ] as const) {
    assert.deepEqual(dimensions(file), [size, size]);
  }
});

test("every linked launch image exists at its advertised resolution", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /href="\/favicon\.png\?v=[a-f0-9]{12}" type="image\/png" sizes="32x32"/);
  assert.match(html, /href="\/favicon-16\.png\?v=[a-f0-9]{12}" type="image\/png" sizes="16x16"/);
  assert.match(html, /href="\/favicon\.svg\?v=[a-f0-9]{12}" type="image\/svg\+xml"/);
  const images = [...html.matchAll(/href="\/(splash\/apple-splash-(\d+)x(\d+)-(?:dark|light)\.png)"/g)];
  assert.equal(images.length, 24);
  for (const [, file, width, height] of images) {
    assert.deepEqual(dimensions(file), [Number(width), Number(height)]);
  }
});

test("all app icon URLs carry their content hash without changing PWA identity", () => {
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.id, "/");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /href="\/manifest.webmanifest"/);
  const urls = [
    ...manifest.icons.map((icon: { src: string }) => icon.src),
    ...manifest.shortcuts.flatMap((shortcut: { icons: { src: string }[] }) => shortcut.icons.map((icon) => icon.src)),
    ...[...html.matchAll(/href="(\/(?:favicon|favicon-16|apple-touch-icon)\.(?:png|svg)[^\"]*)"/g)].map((match) => match[1]),
  ];
  for (const url of urls) {
    const parsed = new URL(url, "https://remote-hand.test");
    const bytes = readFileSync(new URL(`../public${parsed.pathname}`, import.meta.url));
    assert.equal(parsed.searchParams.get("v"), createHash("sha256").update(bytes).digest("hex").slice(0, 12));
  }
});

test("favicon and in-app icons preserve alpha; system-masked icons stay opaque", () => {
  for (const file of ["favicon.png", "favicon-16.png", "icon-192.png", "icon-512.png"]) {
    const bytes = readFileSync(new URL(`../public/${file}`, import.meta.url));
    assert.equal(bytes[25], 6, `${file} must be RGBA for transparent corners`);
    const [size] = dimensions(file);
    const decoded = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image width="${size}" height="${size}" href="data:image/png;base64,${bytes.toString("base64")}"/></svg>`).render().pixels;
    for (const pixel of [0, size - 1, size * (size - 1), size * size - 1]) {
      assert.equal(decoded[pixel * 4 + 3], 0, `${file} corner must be transparent`);
    }
    assert.equal(decoded[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3], 255);
  }
  for (const file of ["apple-touch-icon.png", "icon-maskable-512.png"]) {
    const bytes = readFileSync(new URL(`../public/${file}`, import.meta.url));
    // Opaque truecolour or an opaque palette: the flat two-colour mark fits a palette.
    assert.ok([2, 3].includes(bytes[25]), `${file} must be full-bleed and opaque for the OS mask`);
  }
});

test("the favicon is the black mark on a transparent ground and turns white in a dark browser", () => {
  const svg = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");
  assert.doesNotMatch(svg, /<rect/, "no tile behind the browser favicon");
  assert.match(svg, /path\{fill:#0a0a0a\}/);
  assert.match(svg, /@media \(prefers-color-scheme:dark\)\{path\{fill:#ffffff\}\}/);
  // The PNG fallbacks: ink where the mark is, nothing else.
  for (const file of ["favicon.png", "favicon-16.png"]) {
    const bytes = readFileSync(new URL(`../public/${file}`, import.meta.url));
    const [size] = dimensions(file);
    const decoded = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image width="${size}" height="${size}" href="data:image/png;base64,${bytes.toString("base64")}"/></svg>`).render().pixels;
    const centre = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
    assert.deepEqual([...decoded.subarray(centre, centre + 4)], [10, 10, 10, 255], `${file} centre is ink`);
  }
});
