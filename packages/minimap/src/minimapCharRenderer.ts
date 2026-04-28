import { clamp8 } from "./color";
import { Constants, getCharIndex } from "./minimapCharSheet";
import type { RGBA8 } from "./types";

export class MinimapCharRenderer {
  private readonly charDataNormal: Uint8ClampedArray;
  private readonly charDataLight: Uint8ClampedArray;

  public constructor(
    charData: Uint8ClampedArray,
    public readonly scale: number,
  ) {
    this.charDataNormal = MinimapCharRenderer.soften(charData, 12 / 15);
    this.charDataLight = MinimapCharRenderer.soften(charData, 50 / 60);
  }

  public renderChar(
    target: ImageData,
    dx: number,
    dy: number,
    chCode: number,
    color: RGBA8,
    foregroundAlpha: number,
    backgroundColor: RGBA8,
    backgroundAlpha: number,
    fontScale: number,
    useLighterFont: boolean,
    force1pxHeight: boolean,
  ): void {
    const charWidth = Constants.BASE_CHAR_WIDTH * this.scale;
    const charHeight = Constants.BASE_CHAR_HEIGHT * this.scale;
    const renderHeight = force1pxHeight ? 1 : charHeight;
    if (dx + charWidth > target.width || dy + renderHeight > target.height) return;

    this.renderCharData({
      target,
      dx,
      dy,
      charWidth,
      renderHeight,
      charIndex: getCharIndex(chCode, fontScale),
      color,
      foregroundAlpha,
      backgroundColor,
      backgroundAlpha,
      charData: useLighterFont ? this.charDataLight : this.charDataNormal,
    });
  }

  public blockRenderChar(
    target: ImageData,
    dx: number,
    dy: number,
    color: RGBA8,
    foregroundAlpha: number,
    backgroundColor: RGBA8,
    backgroundAlpha: number,
    force1pxHeight: boolean,
  ): void {
    const charWidth = Constants.BASE_CHAR_WIDTH * this.scale;
    const charHeight = Constants.BASE_CHAR_HEIGHT * this.scale;
    const renderHeight = force1pxHeight ? 1 : charHeight;
    if (dx + charWidth > target.width || dy + renderHeight > target.height) return;

    const blended = blendForeground(color, backgroundColor, 0.5 * (foregroundAlpha / 255));
    const destAlpha = Math.max(foregroundAlpha, backgroundAlpha);
    const destWidth = target.width * Constants.RGBA_CHANNELS_CNT;
    let row = dy * destWidth + dx * Constants.RGBA_CHANNELS_CNT;

    for (let y = 0; y < renderHeight; y += 1) {
      writeBlockRow(target.data, row, charWidth, blended, destAlpha);
      row += destWidth;
    }
  }

  private renderCharData(options: RenderCharDataOptions): void {
    const dest = options.target.data;
    const destWidth = options.target.width * Constants.RGBA_CHANNELS_CNT;
    const destAlpha = Math.max(options.foregroundAlpha, options.backgroundAlpha);
    const deltaR = options.color.r - options.backgroundColor.r;
    const deltaG = options.color.g - options.backgroundColor.g;
    const deltaB = options.color.b - options.backgroundColor.b;
    let sourceOffset =
      options.charIndex * options.charWidth * Constants.BASE_CHAR_HEIGHT * this.scale;
    let row = options.dy * destWidth + options.dx * Constants.RGBA_CHANNELS_CNT;

    for (let y = 0; y < options.renderHeight; y += 1) {
      sourceOffset = writeCharRow(dest, row, sourceOffset, {
        charWidth: options.charWidth,
        charData: options.charData,
        foregroundAlpha: options.foregroundAlpha,
        backgroundColor: options.backgroundColor,
        deltaR,
        deltaG,
        deltaB,
        destAlpha,
      });
      row += destWidth;
    }
  }

  private static soften(input: Uint8ClampedArray, ratio: number): Uint8ClampedArray {
    const result = new Uint8ClampedArray(input.length);
    for (let index = 0; index < input.length; index += 1)
      result[index] = clamp8(input[index]! * ratio);
    return result;
  }
}

type RenderCharDataOptions = {
  readonly target: ImageData;
  readonly dx: number;
  readonly dy: number;
  readonly charWidth: number;
  readonly renderHeight: number;
  readonly charIndex: number;
  readonly color: RGBA8;
  readonly foregroundAlpha: number;
  readonly backgroundColor: RGBA8;
  readonly backgroundAlpha: number;
  readonly charData: Uint8ClampedArray;
};

type WriteCharRowOptions = {
  readonly charWidth: number;
  readonly charData: Uint8ClampedArray;
  readonly foregroundAlpha: number;
  readonly backgroundColor: RGBA8;
  readonly deltaR: number;
  readonly deltaG: number;
  readonly deltaB: number;
  readonly destAlpha: number;
};

function writeCharRow(
  dest: Uint8ClampedArray,
  row: number,
  sourceOffset: number,
  options: WriteCharRowOptions,
): number {
  let column = row;
  let source = sourceOffset;
  for (let x = 0; x < options.charWidth; x += 1) {
    const c = ((options.charData[source] ?? 0) / 255) * (options.foregroundAlpha / 255);
    source += 1;
    dest[column++] = options.backgroundColor.r + options.deltaR * c;
    dest[column++] = options.backgroundColor.g + options.deltaG * c;
    dest[column++] = options.backgroundColor.b + options.deltaB * c;
    dest[column++] = options.destAlpha;
  }
  return source;
}

function writeBlockRow(
  dest: Uint8ClampedArray,
  row: number,
  width: number,
  color: RGBA8,
  alpha: number,
): void {
  let column = row;
  for (let x = 0; x < width; x += 1) {
    dest[column++] = color.r;
    dest[column++] = color.g;
    dest[column++] = color.b;
    dest[column++] = alpha;
  }
}

function blendForeground(color: RGBA8, background: RGBA8, amount: number): RGBA8 {
  return {
    r: background.r + (color.r - background.r) * amount,
    g: background.g + (color.g - background.g) * amount,
    b: background.b + (color.b - background.b) * amount,
    a: 255,
  };
}
