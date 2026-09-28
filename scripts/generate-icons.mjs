import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CalendarDays } from 'lucide-react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const iconsDir = path.resolve(projectRoot, 'public/icons');
const tokensCssPath = path.resolve(projectRoot, 'src/client/styles/tokens.css');

/**
 * Parse design tokens from tokens.css
 */
async function loadTokens() {
  const css = await fs.readFile(tokensCssPath, 'utf-8');
  const tokens = {};
  const tokenRegex = /--([\w-]+)\s*:\s*([^;]+);/g;
  let match = tokenRegex.exec(css);
  while (match !== null) {
    const key = match[1];
    const value = match[2];
    if (key && value) {
      tokens[key] = value.trim();
    }
    match = tokenRegex.exec(css);
  }

  const required = ['bg', 'surface', 'accent', 'ink', 'line'];
  for (const name of required) {
    if (!tokens[name]) {
      throw new Error(`Missing required token --${name} in ${tokensCssPath}`);
    }
  }

  return tokens;
}

/**
 * Generate a single PWA PNG icon from React + Lucide CalendarDays + Sharp
 */
async function generateIcon({ tokens, size, filename, isMaskable = false, isAppleTouch = false }) {
  const iconSize = isMaskable
    ? Math.round(size * 0.52)
    : isAppleTouch
      ? Math.round(size * 0.58)
      : Math.round(size * 0.55);

  const offset = Math.round((size - iconSize) / 2);
  const rx = isMaskable || isAppleTouch ? 0 : Math.round(size * 0.2);

  const lucideSvg = renderToStaticMarkup(
    React.createElement(CalendarDays, {
      size: iconSize,
      color: tokens.surface,
      strokeWidth: 2,
    }),
  );

  const fullSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${rx}" fill="${tokens.accent}" />
  <g transform="translate(${offset}, ${offset})">
    ${lucideSvg}
  </g>
</svg>
`.trim();

  const outputPath = path.join(iconsDir, filename);
  await sharp(Buffer.from(fullSvg)).resize(size, size).png().toFile(outputPath);

  console.log(`Generated ${filename} (${size}x${size})`);
}

/**
 * Generate public/favicon.svg from the same Lucide CalendarDays source
 */
async function generateFaviconSvg(tokens) {
  const size = 32;
  const iconSize = 20;
  const offset = Math.round((size - iconSize) / 2);

  const lucideSvg = renderToStaticMarkup(
    React.createElement(CalendarDays, {
      size: iconSize,
      color: tokens.surface,
      strokeWidth: 2,
    }),
  );

  const faviconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="6" fill="${tokens.accent}" />
  <g transform="translate(${offset}, ${offset})">
    ${lucideSvg}
  </g>
</svg>
`.trim();

  const faviconPath = path.join(projectRoot, 'public/favicon.svg');
  await fs.writeFile(faviconPath, `${faviconSvg}\n`, 'utf-8');
  console.log('Generated favicon.svg (32x32)');
}

async function main() {
  const tokens = await loadTokens();
  await fs.mkdir(iconsDir, { recursive: true });

  await Promise.all([
    // Vector SVG favicon
    generateFaviconSvg(tokens),

    // Standard PWA manifest icons (purpose: any)
    generateIcon({ tokens, size: 192, filename: 'icon-192.png' }),
    generateIcon({ tokens, size: 512, filename: 'icon-512.png' }),

    // Maskable PWA icon (purpose: maskable, safe zone padding)
    generateIcon({ tokens, size: 512, filename: 'icon-512-maskable.png', isMaskable: true }),

    // Apple Touch Icon (180x180, opaque)
    generateIcon({ tokens, size: 180, filename: 'apple-touch-icon.png', isAppleTouch: true }),
  ]);

  console.log('All PWA icons and favicon successfully generated.');
}

main().catch((err) => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
