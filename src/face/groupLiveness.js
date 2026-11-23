// Liveness for a group photo: is each face in the crew a real person, or a picture of one?
//
// A single still cannot tell. So before the shutter fires the live preview follows every face from frame to
// frame and asks each person to turn their head. A real head turning shows 3-D depth -- the nose moves off
// the plane of the eyes, brows and mouth (depthCheck.js). A printed photo, or a photo or video of a face on
// a phone or monitor held up to the camera, is flat: however it is tilted or moved, it never shows depth, and
// it is never counted. A flat picture also barely changes the nose-to-eyes offset when tilted, so it usually
// never even registers as "turned".
//
// Pure: fed per-frame face measurements ({ box, yaw, points } from faceEngine.analyseFaces), so it is
// unit-tested without a camera. Each face is judged on its own, so one real person cannot vouch for a
// picture held up beside them.
import { depthVerdict } from './depthCheck.js';

export const GROUP_LIVENESS_DEFAULTS = {
  neutralFrames: 3,     // frames facing the camera that fix this face's neutral pose
  turnYaw: 0.15,        // movement from neutral that counts as a head turn (inter-eye distances)
  maxNeutral: 6,
  maxMoved: 8,
  maxMissed: 8,         // frames a face may vanish (detector miss, someone in front) before its track ends
  matchDistance: 0.8,   // a face continues a track whose centre is within this many face widths
};

const centre = (b) => [b.x + b.width / 2, b.y + b.height / 2];

export function createGroupLiveness(options = {}) {
  const o = { ...GROUP_LIVENESS_DEFAULTS, ...options };
  let tracks = [];
  let nextId = 1;

  function judge(t) {
    if (t.live || !t.moved.length || t.neutral.length < 2) return;
    const v = depthVerdict(t.neutral, t.moved);
    t.score = Math.max(t.score, v.score);
    if (v.live) t.live = true;
  }

  // faces: [{ box, yaw, points }] in one video frame. Returns the current state (see snapshot()).
  function feed(faces) {
    const free = new Set(tracks);
    for (const f of faces ?? []) {
      if (!f?.box || !Number.isFinite(f.yaw) || !Array.isArray(f.points)) continue;
      const [cx, cy] = centre(f.box);
      let best = null;
      let bestD = Infinity;
      for (const t of free) {
        const [tx, ty] = centre(t.box);
        const d = Math.hypot(cx - tx, cy - ty) / Math.max(1, t.box.width);
        if (d < bestD) { bestD = d; best = t; }
      }
      let t = bestD <= o.matchDistance ? best : null;
      if (!t) {
        t = { id: nextId++, box: f.box, calib: [], neutralYaw: null, neutral: [], moved: [], live: false, score: 0, turned: false, missed: 0 };
        tracks.push(t);
      } else {
        free.delete(t);
      }
      t.box = f.box;
      t.missed = 0;
      if (t.neutralYaw == null) {
        t.calib.push(f.yaw);
        t.neutral.push(f.points);
        if (t.calib.length >= o.neutralFrames) t.neutralYaw = t.calib.reduce((s, y) => s + y, 0) / t.calib.length;
        continue;
      }
      const off = Math.abs(f.yaw - t.neutralYaw);
      if (off > o.turnYaw) {
        t.turned = true;
        if (t.moved.length < o.maxMoved) t.moved.push(f.points);
        judge(t);
      } else if (off < o.turnYaw / 2 && t.neutral.length < o.maxNeutral) {
        t.neutral.push(f.points);
      }
    }
    for (const t of free) t.missed += 1;
    tracks = tracks.filter((t) => t.missed <= o.maxMissed);
    return snapshot();
  }

  function snapshot() {
    const visible = tracks.filter((t) => t.missed === 0);
    return {
      tracks: tracks.map((t) => ({ id: t.id, box: t.box, live: t.live, turned: t.turned, score: Math.round(t.score * 1000) / 1000, visible: t.missed === 0 })),
      total: visible.length,
      live: visible.filter((t) => t.live).length,
    };
  }

  return { feed, snapshot };
}

// The live track a face found in the full-resolution still belongs to, or null. `sx`/`sy` scale the
// still's coordinates back to the preview's.
export function liveTrackFor(tracks, box, { sx = 1, sy = 1, tolerance = 0.9 } = {}) {
  const b = { x: box.x / sx, y: box.y / sy, width: box.width / sx, height: box.height / sy };
  const [cx, cy] = centre(b);
  let best = null;
  let bestD = Infinity;
  for (const t of tracks ?? []) {
    const [tx, ty] = centre(t.box);
    const d = Math.hypot(cx - tx, cy - ty) / Math.max(1, b.width, t.box.width);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best && bestD <= tolerance && best.live ? best : null;
}
