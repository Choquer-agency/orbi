// 1x1 transparent PNG (43 bytes)
export const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export function injectTrackingPixel(bodyHtml: string, trackingId: string, baseUrl: string): string {
  const pixelTag = `<img src="${baseUrl}/p/${trackingId}.png" width="1" height="1" style="display:none;border:0;" alt="" />`;

  // Insert before closing </body> or </html> tag, or append at end
  if (bodyHtml.includes('</body>')) {
    return bodyHtml.replace('</body>', `${pixelTag}</body>`);
  }
  if (bodyHtml.includes('</html>')) {
    return bodyHtml.replace('</html>', `${pixelTag}</html>`);
  }
  return bodyHtml + pixelTag;
}
