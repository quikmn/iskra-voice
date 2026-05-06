// Generates all PWA icon sizes from an inline SVG spark logo.
// Run: node generate-icons.js

const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

// Iskra spark — electric blue lightning bolt on near-black background
const sparkSvg = (size, maskable = false) => {
    const pad = maskable ? size * 0.18 : size * 0.12;
    const w   = size - pad * 2;
    const h   = size - pad * 2;
    const ox  = pad;
    const oy  = pad;
    const pts = [
        [0.62, 0.00],
        [0.38, 0.00],
        [0.20, 0.50],
        [0.42, 0.50],
        [0.22, 1.00],
        [0.58, 1.00],
        [0.78, 0.50],
        [0.58, 0.50],
    ].map(([px, py]) => `${ox + px * w},${oy + py * h}`).join(' ');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7dd3fc"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="${size * 0.018}" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${size}" height="${size}" rx="${maskable ? size * 0.18 : size * 0.22}" fill="#0d0f17"/>
  <polygon points="${pts}" fill="url(#g)" filter="url(#glow)"/>
</svg>`;
};

async function gen(svgStr, filename) {
    await sharp(Buffer.from(svgStr)).png().toFile(path.join(outDir, filename));
    console.log(`  ✓ icons/${filename}`);
}

(async () => {
    console.log('Generating icons...');
    await gen(sparkSvg(192),         'icon-192.png');
    await gen(sparkSvg(512),         'icon-512.png');
    await gen(sparkSvg(512, true),   'icon-maskable-512.png');
    await gen(sparkSvg(180),         'apple-touch-icon.png');
    console.log('Done.');
})();
