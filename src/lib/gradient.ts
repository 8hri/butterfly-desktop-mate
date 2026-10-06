import { CanvasTexture, SRGBColorSpace, type Texture } from "three";

const cache = new Map<string, Texture>();

/**
 * Vertical gradient texture, used for the sky dome.
 *
 * Drawn once into a tiny canvas and cached, so it costs a few kilobytes
 * instead of shipping an image. Canvas row 0 maps to the top of the texture
 * (v = 1), which is the top of the sky sphere.
 */
export function verticalGradientTexture(colors: string[], height = 256): Texture {
  const key = colors.join("|");
  const cached = cache.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas context unavailable");

  const gradient = context.createLinearGradient(0, 0, 0, height);
  colors.forEach((color, index) => {
    gradient.addColorStop(index / (colors.length - 1), color);
  });
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, height);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  cache.set(key, texture);
  return texture;
}
