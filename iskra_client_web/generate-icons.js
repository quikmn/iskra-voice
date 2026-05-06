// Generates all PWA icon sizes from an inline SVG spark logo.
// Run: node generate-icons.js

const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

// Iskra spark — lightning bolt on dark purple background
const sparkSvg = (size, maskable = false) => {
    const pad    = maskable ? size * 0.18 : size * 0.12;
    const w      = size - pad * 2;
    const h      = size - pad * 2;
    const ox     = pad;
    const oy     = pad;
    // Lightning bolt path scaled to (ox,oy) + (w,h)
    // Points: top-right → mid-right → bottom-right → bottom-left → mid-left → top-left
    const pts = [
        [0.62, 0.00],  // top-right of top bar
        [0.38, 0.00],  // top-left of top bar
        [0.20, 0.50],  // mid-left tip
        [0.42, 0.50],  // mid inner-left
        [0.22, 1.00],  // bottom-left
        [0.58, 1.00],  // bottom-right
        [0.78, 0.50],  // mid inner-right
        [0.58, 0.50],  // mid outer-right
    ].map(([px, py]) => `${ox + px * w},${oy + py * h}`).join(' ');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${maskable ? size * 0.18 : size * 0.22}" fill="#0b0b14"/>
  <polygon points="${pts}" fill="#7c3aed"/>
  <polygon points="${pts}" fill="url(#g)" opacity="0.55"/>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#a78bfa"/>
      <stop offset="1" stop-color="#4c1d95"/>
    </linearGradient>
  </defs>
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
