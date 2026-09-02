/**
 * Framing geometry — closed form, CSS preview, Remotion lerp, and snaps.
 *
 * Run: npm run test:zoom-math
 */
import {
  ZOOM_SNAP_RATIOS,
  cssContainScaleWindow,
  cssContainTransform,
  framingGeometry,
  labelForAspect,
  scaleCoverForCanvas,
  snapsForCanvas,
  sourceMatchesCanvas,
  spreadPositions,
  videoSizeAtZoom,
  visibleWindow,
  windowAspectForZoom,
  zoomForWindowAspect,
} from "../lib/zoomMath";

const S = 16 / 9;
let checks = 0;
let failures = 0;

function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

function nearly(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

const CASES: [string, number, number, number][] = [
  ["9:16 1080x1920", 1080, 1920, S],
  ["1:1 1080x1080", 1080, 1080, S],
  ["16:9 1920x1080", 1920, 1080, S],
  ["portrait src in 16:9", 1920, 1080, 9 / 16],
  ["4:3 src in 9:16", 1080, 1920, 4 / 3],
];

console.log("closed form ↔ pixel lerp, CSS window, snap invert");
for (const [name, W, H, src] of CASES) {
  const C = W / H;
  const g = framingGeometry(W, H, src);
  const z0 = visibleWindow(0, W, H, src);

  assert(
    nearly(z0.width, Math.min(g.containW, W)),
    `${name} z0 width ${z0.width} vs contain ${g.containW}`,
  );
  assert(
    nearly(z0.height, Math.min(g.containH, H)),
    `${name} z0 height ${z0.height} vs contain ${g.containH}`,
  );

  for (const z of [0, 0.25, 0.5, 0.75, 1]) {
    const lerp = visibleWindow(z, W, H, src);
    const css = cssContainScaleWindow(z, W, H, src);
    assert(
      nearly(lerp.width, css.width, 1e-6) &&
        nearly(lerp.height, css.height, 1e-6),
      `${name} css≠lerp at z=${z}: ${lerp.width}x${lerp.height} vs ${css.width}x${css.height}`,
    );

    if (!sourceMatchesCanvas(C, src)) {
      const scaleCover = scaleCoverForCanvas(C, src);
      const scale = 1 + z * (scaleCover - 1);
      const Rclosed = src >= C ? src / scale : src * scale;
      assert(
        nearly(Rclosed, lerp.aspect),
        `${name} closed R at z=${z}: ${Rclosed} vs ${lerp.aspect}`,
      );
    }
  }

  if (!sourceMatchesCanvas(C, src)) {
    for (const r of ZOOM_SNAP_RATIOS) {
      const aspect = r.width / r.height;
      const z = zoomForWindowAspect(aspect, C, src);
      if (z === null) continue;
      const got = windowAspectForZoom(z, C, src);
      assert(
        nearly(got, aspect, 1e-6),
        `${name} invert ${r.label}: z=${z} got ${got} want ${aspect}`,
      );
    }
  }

  if (src >= C && !sourceMatchesCanvas(C, src)) {
    const f0 = visibleWindow(0, W, H, src).fillY;
    const f1 = visibleWindow(1, W, H, src).fillY;
    const fmid = visibleWindow(0.5, W, H, src).fillY;
    assert(nearly(fmid, (f0 + f1) / 2), `${name} fillY not linear`);
    assert(nearly(f1, 1), `${name} fillY at cover is ${f1}`);
  }
}

console.log("one match test for near-equal 9:16");
{
  const C = 9 / 16;
  const src = C + 0.009;
  const W = 1080;
  const H = 1920;
  const absWouldHaveMatched = Math.abs(C - src) < 0.01;
  const matched = sourceMatchesCanvas(C, src);
  const g = framingGeometry(W, H, src);
  assert(absWouldHaveMatched, "fixture: |C−S| < 0.01");
  assert(
    matched === g.matchesSource,
    `sourceMatchesCanvas (${matched}) ≠ framingGeometry.matchesSource (${g.matchesSource})`,
  );
  assert(
    (scaleCoverForCanvas(C, src) === 2) === matched,
    "scaleCoverForCanvas digital-zoom flag disagrees with match test",
  );
}

console.log("snaps ordered by zoom");
{
  const portraitSnaps = snapsForCanvas(16 / 9, 9 / 16);
  assert(portraitSnaps.length > 1, "portrait source on 16:9 should have snaps");
  for (let i = 1; i < portraitSnaps.length; i++) {
    assert(
      portraitSnaps[i].zoom >= portraitSnaps[i - 1].zoom,
      `snaps not sorted: ${portraitSnaps[i - 1].label}@${portraitSnaps[i - 1].zoom} then ${portraitSnaps[i].label}@${portraitSnaps[i].zoom}`,
    );
  }
  assert(
    portraitSnaps[0].label === "9:16" &&
      portraitSnaps[portraitSnaps.length - 1].label === "16:9",
    `expected 9:16…16:9, got ${portraitSnaps.map((s) => s.label).join(",")}`,
  );
}

console.log("3:4 is a first-class snap, not a guessed zoom");
{
  assert(
    ZOOM_SNAP_RATIOS.some((r) => r.label === "3:4" && r.width === 3 && r.height === 4),
    "ZOOM_SNAP_RATIOS must include 3:4",
  );
  assert(labelForAspect(3 / 4) === "3:4", `labelForAspect(3/4) is ${labelForAspect(3 / 4)}`);
  assert(labelForAspect(4 / 5) === "4:5", "4:5 must still win over nearby 3:4");

  // Independent closed form (S ≥ C): zoom = (S/R − 1) / (S/C − 1)
  const src = 16 / 9;
  const C = 9 / 16;
  const R = 3 / 4;
  const expectedZoom = (src / R - 1) / (src / C - 1);
  assert(
    nearly(expectedZoom, 111 / 175),
    `3:4 closed zoom should be 111/175, got ${expectedZoom}`,
  );

  const z = zoomForWindowAspect(R, C, src);
  assert(z !== null, "3:4 must be reachable on a 9:16 canvas with 16:9 source");
  assert(
    nearly(z!, expectedZoom, 1e-12),
    `zoomForWindowAspect(3:4) = ${z} want ${expectedZoom}`,
  );
  assert(
    nearly(windowAspectForZoom(z!, C, src), R, 1e-12),
    `round-trip window for 3:4: ${windowAspectForZoom(z!, C, src)}`,
  );

  const portraitSnaps = snapsForCanvas(C, src);
  const threeFour = portraitSnaps.find((s) => s.label === "3:4");
  const fourFive = portraitSnaps.find((s) => s.label === "4:5");
  assert(!!threeFour, `9:16 snaps missing 3:4: ${portraitSnaps.map((s) => s.label).join(",")}`);
  assert(
    nearly(threeFour!.zoom, expectedZoom, 1e-12),
    `snap zoom ${threeFour!.zoom} ≠ closed form ${expectedZoom}`,
  );
  assert(!!fourFive, "4:5 must remain a snap next to 3:4");
  assert(
    Math.abs(threeFour!.zoom - fourFive!.zoom) >= 0.01,
    "3:4 must not be collapsed into 4:5 by the 0.01 duplicate filter",
  );

  const squareSnaps = snapsForCanvas(1, src);
  assert(
    squareSnaps.every((s) => s.label !== "3:4"),
    "3:4 is outside [1, 16:9] on a square canvas and must not appear",
  );

  const landscapeFromPortrait = snapsForCanvas(src, C);
  const threeFourOnLandscape = landscapeFromPortrait.find((s) => s.label === "3:4");
  // S < C: zoom = (R/S − 1) / (C/S − 1)
  const expectedLandscapeZoom = (R / C - 1) / (src / C - 1);
  assert(!!threeFourOnLandscape, "3:4 must be reachable from 9:16 source on 16:9 canvas");
  assert(
    nearly(threeFourOnLandscape!.zoom, expectedLandscapeZoom, 1e-12),
    `portrait-src 3:4 zoom ${threeFourOnLandscape!.zoom} want ${expectedLandscapeZoom}`,
  );
}

console.log("label spread keeps 3:4 off 4:5 without leaving [0,1]");
{
  const spaced = spreadPositions([0, 0.5, 1], 0.1);
  assert(
    nearly(spaced[0], 0) && nearly(spaced[1], 0.5) && nearly(spaced[2], 1),
    `already-spaced points moved: ${spaced.join(",")}`,
  );

  const tight = spreadPositions([0.566, 0.634], 0.08);
  assert(tight[1] - tight[0] >= 0.08 - 1e-12, `tight pair gap ${tight[1] - tight[0]}`);
  assert(tight[0] >= -1e-12 && tight[1] <= 1 + 1e-12, `spread left [0,1]: ${tight}`);
  assert(tight[0] <= 0.566 + 1e-12 && tight[1] >= 0.634 - 1e-12, "spread should not invert order");

  const packed = spreadPositions([0.1, 0.11, 0.12, 0.13], 0.4);
  const packedGap = 1 / 3;
  for (let i = 1; i < packed.length; i++) {
    assert(
      nearly(packed[i] - packed[i - 1], packedGap, 1e-12),
      `overfull pack gap ${packed[i] - packed[i - 1]} want ${packedGap}`,
    );
  }
  assert(nearly(packed[0], 0) && nearly(packed[packed.length - 1], 1), "overfull pack must fill [0,1]");

  const C = 9 / 16;
  const src = 16 / 9;
  const zooms = snapsForCanvas(C, src).map((s) => s.zoom);
  // 11px labels + 5px air on a 254px track (h-80 minus chrome).
  const laidOut = spreadPositions(zooms, 16 / 254);
  for (let i = 1; i < laidOut.length; i++) {
    assert(
      laidOut[i] - laidOut[i - 1] >= 16 / 254 - 1e-12,
      `label ${i} gap ${laidOut[i] - laidOut[i - 1]}`,
    );
  }
  const threeFourIdx = snapsForCanvas(C, src).findIndex((s) => s.label === "3:4");
  assert(threeFourIdx >= 0, "layout fixture missing 3:4");
  assert(
    Math.abs(laidOut[threeFourIdx] - zooms[threeFourIdx]) < 0.02,
    `3:4 label should stay near its tick: ${laidOut[threeFourIdx]} vs ${zooms[threeFourIdx]}`,
  );
}

console.log("CSS pan matches Remotion overflow shift");
{
  const W = 1080;
  const H = 1920;
  const src = S;
  const C = W / H;
  for (const z of [0.3, 0.7, 1]) {
    for (const focusX of [0, 0.5, 1]) {
      const { width: videoW } = videoSizeAtZoom(z, W, H, src);
      const overflowX = videoW - W;
      const remotionLeft = overflowX > 0 ? -(focusX - 0.5) * overflowX : 0;
      const { translateX } = cssContainTransform(z, C, src, focusX, 0.5);
      const cssPx = (translateX / 100) * W;
      assert(
        nearly(cssPx, remotionLeft, 1e-6),
        `pan z=${z} focusX=${focusX}: css ${cssPx} vs remotion ${remotionLeft}`,
      );
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} failed`);
  process.exit(1);
}
console.log(`OK: ${checks} checks`);
