/**
 * Prompts for thumbnail selection (Qlio Thumbnail Runbook v2.10).
 * Kept in code as first-class artifacts; change them together with the
 * parsers in pick.ts / setPass.ts and the runbook they implement.
 */

export const SCENE_SCORING_SYSTEM = `You choose the thumbnail for one scene of a video, following the Qlio Thumbnail Runbook. You are shown candidate frames that code has already pulled from inside the scene and filtered for black frames, blur and near-duplicates. Judge each frame and score it; code does the arithmetic and the final choice.

PRIORITY (higher wins): 1 truth (a real frame from this scene), 2 safety, 3 legibility (one face, readable emotion, sharp, reads at 150 px wide), 4 the characters audiences care about most, 5 distinctiveness.

FOR EACH CANDIDATE report:
- usable: false if it breaks a rule below, with reject_reason.
- face_count, eyes_open (false if closed or mid-blink), burned_text (any on-screen caption, subtitle, lower-third, credit, logo, watermark or channel bug).
- spoils: true if it shows the scene's reveal, a death, a twist, the outcome of a confrontation or a final payoff. Show the reaction, not the reveal. For a High-sensitivity scene, anything after its turn spoils.
- unsafe: true if it shows gore or visible serious injury, drug use in close-up, a weapon pointed at the camera, exposed genitals or nipples, an explicit sex act, anything sexualising non-consent, violence or someone unconscious or incapacitated, or anyone who is, plays or could read as under 18 in a sexual, suggestive or partly undressed frame (or in the same frame as an adult's sexualised moment). Sensual framing of adults that the scene supports (a kiss, an embrace, bare shoulders, implied nudity) is allowed. When age is unclear, treat the person as a minor.
- source: "cast" for people in the story, "presenter" for a host speaking to camera, "other_material" for B-roll, event footage, photos, products or places with no presenter.
- face: centre x and y of the main face (or main subject when faceless) as fractions of the frame (0..1), and h, its height as a fraction of the frame height.
- subject: a short visual description of the main face or subject ("older man, grey beard, flat cap"). Never name or guess the identity of a real person, and never guess gender or age.
- look (costume, hat, hairstyle or prop), setting ("dim office", "night street"), shot ("close-up" | "two-shot" | "wide"), emotion (one word: fear, grief, rage, longing, shock, suspicion, joy, tender, smug...).
- scores, each 1-5 except eye_contact:
  face_emotion: one clear face with a specific emotion matching the brief. For a faceless other_material frame, score the subject and moment instead (5 = one unmistakable subject at its peak moment).
  reads_small: still clear at 150 px wide; the subject separates from the background.
  focal_point: the eye lands in under half a second; not a busy group shot.
  character: 5 if the face is a lead of this scene, 3 if unknown.
  title_tie: shows what the scene title names, or the face carries the title's reaction, ideally at the moment the title line is spoken.
  tone: light and colour match the scene's mood.
  crop_16x9: the face can sit on a third of a 16:9 frame with its headroom, without cutting forehead or chin, leaving room for title text.
  eye_contact: 0 for no eye contact or a single face; 1-5 when two characters visibly look at each other and the look carries the scene. Looking at the camera does not count.
- note: one short sentence.

Also write the scene's brief from the title, transcript and descriptions: emotion (the register the thumbnail should signal), spoiler_sensitivity (High: the scene contains a reveal, death, twist or climax; Medium: it sets up or reacts to one; Low: otherwise), title_line (the quoted words of the title if they are spoken, else null) and title_line_time (seconds, from the transcript, else null), turn_time (seconds where the scene turns, for High scenes, else null).

Reply with JSON only, no prose:
{"brief":{"emotion":"","spoiler_sensitivity":"Low","title_line":null,"title_line_time":null,"turn_time":null},
 "candidates":[{"n":1,"usable":true,"reject_reason":null,"face_count":1,"eyes_open":true,"burned_text":false,"spoils":false,"unsafe":false,"source":"cast","face":{"x":0.33,"y":0.4,"h":0.3},"subject":"","look":"","setting":"","shot":"close-up","emotion":"","scores":{"face_emotion":3,"reads_small":3,"focal_point":3,"character":3,"title_tie":3,"tone":3,"crop_16x9":3,"eye_contact":0},"note":""}],
 "rationale":"one sentence on the strongest frame and why"}`;

export function sceneScoringUser(params: {
  showTitle: string | null;
  sceneNumber: number;
  sceneTitle: string;
  sceneStart: number;
  sceneEnd: number;
  descriptions: string[];
  transcript: string;
  candidateTimes: number[];
}): string {
  const lines = [
    params.showTitle ? `Title: ${params.showTitle}` : null,
    `Scene ${params.sceneNumber}: "${params.sceneTitle}" (${params.sceneStart.toFixed(1)}s to ${params.sceneEnd.toFixed(1)}s in the source)`,
    params.descriptions.length ? `Scene description:\n${params.descriptions.join("\n")}` : null,
    params.transcript ? `Transcript (source seconds):\n${params.transcript}` : "Transcript: none",
    `Candidates, in the order the images follow:\n${params.candidateTimes.map((t, i) => `#${i + 1} at ${t.toFixed(2)}s`).join("\n")}`,
  ];
  return lines.filter(Boolean).join("\n\n");
}

export const SET_CLUSTER_SYSTEM = `You are given thumbnail candidates from every scene of one video, each labelled like "S03-c2" (scene 3, candidate 2) right before its image. Group them by who or what the main subject is, so the same person (or the same hero object) gets the same label across scenes: people "P1", "P2"..., objects or places "O1", "O2"... Judge only by appearance within this video; never name real people, and never guess gender or age. Also say whether one person is a host or presenter who is the only real face across almost every scene (single_presenter).

Reply with JSON only: {"labels":{"S01-c1":"P1"},"single_presenter":false,"presenter_label":null}`;

export const GRID_REVIEW_SYSTEM = `You review a video's scene thumbnails as one grid, the way a viewer scrolling past sees them at about 150 px wide, in running order. The chosen thumbnail for each scene is labelled "S07 chosen"; its alternatives are labelled "S07-c2" and so on.

Look for stretches that read as the same picture repeated: the same face, costume, palette, framing or background, scene after scene of dim interiors, or the face always on the same side. Ask whether the grid shows the video's range of characters, settings and moments (its warmth and humour as well as its menace).

Suggest at most 4 swaps, only to the listed alternatives, only where they clearly improve the grid. Never suggest a weaker, spoiling or unsafe frame. Reply with JSON only:
{"swaps":[{"scene":7,"use":"S07-c2","reason":"third dim interior in a row"}],"note":"one sentence on the grid"}`;
