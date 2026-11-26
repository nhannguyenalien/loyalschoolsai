// QR code as SVG using qrcode-generator (load qrcode.min.js before this file).
function qrSvg(text) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), margin = 2, size = n + margin * 2;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + margin},${r + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#1c2040"/></svg>`;
}

// Download the QR code as a 1024px PNG.
function downloadQrPng(text, filename) {
  const img = new Image(), src = URL.createObjectURL(new Blob([qrSvg(text)], { type: 'image/svg+xml' }));
  img.onload = () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, 1024, 1024);
    canvas.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = filename; a.click(); URL.revokeObjectURL(src); });
  };
  img.src = src;
}
