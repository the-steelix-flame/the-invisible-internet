#!/usr/bin/env node
/**
 * Build the WebP images that `index.html` ships to Vercel.
 *
 * Sources live in `local-source/images/` (git- and Vercel-ignored, so the
 * multi-megabyte PNGs never reach the CDN); the encoded output lands in
 * `assets/`, which does ship. Re-runnable: it always rebuilds from source.
 *
 *   node scripts/optimize-images.js
 */

import { readdir, stat, mkdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(ROOT, 'local-source', 'images');
const OUT_DIR = join(ROOT, 'assets');

// Long-edge cap per slot. Resizing before encoding saves far more than the
// format change alone — the author photo displays at 64x64, so 1122px of
// source pixels is ~99% waste.
const AUTHOR_LONG_EDGE = 256;
const DEFAULT_LONG_EDGE = 1400;

const WEBP_OPTIONS = {
  quality: 84,
  effort: 6,
  // The hero cover is a 3D render on a transparent background; lossy alpha
  // leaves halos around the book edges, so keep the alpha channel pristine.
  alphaQuality: 100,
};

// Slots whose image is a second copy of another source. `peek-cover` shows the
// same 3D cover render as the hero, just smaller.
const ALIASES = { 'peek-cover': 'hero-book-cover' };

const longEdgeFor = (name) =>
  name === 'author-photo' ? AUTHOR_LONG_EDGE : DEFAULT_LONG_EDGE;

async function convert(srcPath, outName) {
  const target = longEdgeFor(outName);
  const image = sharp(srcPath);
  const { width, height } = await image.metadata();

  // Only ever shrink — `withoutEnlargement` keeps smaller sources untouched.
  const pipeline = image.resize({
    width: width >= height ? target : null,
    height: width >= height ? null : target,
    withoutEnlargement: true,
    fit: 'inside',
  });

  const outPath = join(OUT_DIR, `${outName}.webp`);
  const out = await pipeline.webp(WEBP_OPTIONS).toFile(outPath);
  const before = (await stat(srcPath)).size;

  return { outName, before, after: out.size, from: `${width}x${height}`, to: `${out.width}x${out.height}` };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const sources = (await readdir(SRC_DIR))
    .filter((f) => extname(f).toLowerCase() === '.png')
    .sort();

  if (!sources.length) {
    console.error(`No PNGs found in ${SRC_DIR}`);
    process.exitCode = 1;
    return;
  }

  const jobs = sources.map((f) => [join(SRC_DIR, f), basename(f, extname(f))]);
  for (const [alias, source] of Object.entries(ALIASES)) {
    jobs.push([join(SRC_DIR, `${source}.png`), alias]);
  }

  const results = [];
  for (const [srcPath, outName] of jobs) {
    results.push(await convert(srcPath, outName));
  }

  let totalBefore = 0;
  let totalAfter = 0;
  for (const r of results.sort((a, b) => a.outName.localeCompare(b.outName))) {
    totalBefore += r.before;
    totalAfter += r.after;
    const saved = ((1 - r.after / r.before) * 100).toFixed(1);
    console.log(
      `${r.outName.padEnd(18)} ${r.from.padStart(9)} -> ${r.to.padEnd(9)}  ` +
        `${kb(r.before).padStart(10)} -> ${kb(r.after).padStart(9)}  (-${saved}%)`
    );
  }

  // Aliased sources are read twice, so the "before" total counts them twice —
  // report the true on-disk source footprint separately.
  const uniqueBefore = results
    .filter((r) => !(r.outName in ALIASES))
    .reduce((n, r) => n + r.before, 0);

  console.log('-'.repeat(72));
  console.log(`${'TOTAL'.padEnd(18)} ${kb(uniqueBefore).padStart(31)} -> ${kb(totalAfter).padStart(9)}  ` +
    `(-${((1 - totalAfter / uniqueBefore) * 100).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
