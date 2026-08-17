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
  scaleCoverForCanvas,
  snapsForCanvas,
  sourceMatchesCanvas,
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
