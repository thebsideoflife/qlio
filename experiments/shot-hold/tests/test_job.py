"""Job-layer contract. Run from experiments/shot-hold: PYTHONPATH=. .venv/bin/python tests/test_job.py"""

from shothold.geometry import focus_for_center, window, window_width, zoom_for_width
from shothold.job import frame_index, keyframes_for_segment, smooth_zoom

FPS = 2997 / 125


def test_geometry_matches_zoom_math():
    assert abs(window_width(1.0) - (9 / 16) / (16 / 9)) < 1e-9      # 9:16 cover window
    assert abs(zoom_for_width((3 / 4) / (16 / 9)) - 0.635) < 0.002  # editor's 3:4 snap
    l, r = window(1.0, focus_for_center(0.8, 1.0))
    assert abs((l + r) / 2 - 0.8) < 1e-9


def test_keyframes_land_on_cut_frames_and_bounds_are_untouched():
    start, end = 10.013, 30.2  # deliberately off the frame grid
    cuts = [100, 300, 305, 500, 700, 900]
    crops = {0: (1, .5), 1: (1, .2), 2: (1, .8), 3: (1, .8), 4: (1, .21), 5: (.635, .5), 6: (1, .5)}
    kfs = keyframes_for_segment(start, end, FPS, cuts, crops)
    assert kfs[0]["time"] == 0.0 and kfs[0]["focusX"] == 0.2           # crop of the shot the segment opens in
    assert [k["sourceFrame"] for k in kfs[1:]] == [305, 500, 700]       # 5-frame shot at 300 inherits
    for k in kfs[1:]:
        assert frame_index(start + k["time"], FPS) == k["sourceFrame"]  # old crop through N-1, new on N
    assert all(0 <= k["time"] < end - start for k in kfs)


def test_same_crop_across_a_false_cut_writes_nothing():
    kfs = keyframes_for_segment(0, 20, FPS, [100, 200], {0: (1, .3), 1: (1, .31), 2: (1, .3)})
    assert len(kfs) == 1


def test_lambda_trades_zoom_changes_for_looseness():
    durs = [2.0] * 6
    needs = [(.4, .6), (.3, .7), (.4, .6), (.3, .7), (.4, .6), None]
    stops = [1.0, 0.635, 0.36]
    flips = lambda zs: sum(a != b for a, b in zip(zs, zs[1:]))
    assert flips(smooth_zoom(durs, needs, stops, 0.0)) == 4
    assert flips(smooth_zoom(durs, needs, stops, 50.0)) == 0
    assert smooth_zoom(durs, needs, stops, 0.0)[-1] == smooth_zoom(durs, needs, stops, 0.0)[-2]  # no-face inherits


def test_exit_split_never_moves_the_letterbox():
    durs = [2.0] * 4
    needs = [(.4, .6), (.3, .7), (.4, .6), (.3, .7)]
    stops = [1.0, 0.635, 0.36]
    free = smooth_zoom(durs, needs, stops, 0.0)
    tied = smooth_zoom(durs, needs, stops, 0.0, tied=[False, True, False, True])  # 1 and 3 are mid-shot splits
    assert free[0] != free[1] and tied[0] == tied[1] and tied[2] == tied[3]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)
