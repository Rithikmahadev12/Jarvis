"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Video Producer
//
// Turns a video-script.js script into an actual .mp4: renders an HTML
// slideshow, opens it in Jarvis's own E2B desktop sandbox (the same
// "computer" textnow-call.js drives), screen-records it with ffmpeg
// while Camb.ai (tts.js) narration for each scene plays, then muxes
// narration over the silent recording into one file.
//
// HONESTY NOTE on the screen-record step: it uses `ffmpeg -f x11grab`
// against a DISPLAY that's assumed to be :1 (overridable via
// DESKTOP_DISPLAY) — that's a best-effort default, not something this
// file has verified against a live sandbox. If recording comes back
// empty/black, check what DISPLAY actually is inside the sandbox
// (Computer.desktopRunCommand("echo $DISPLAY")) and set
// DESKTOP_DISPLAY to match.
// ═══════════════════════════════════════════════════════════════

const Computer = require("./computer");
const TTS = require("./tts");

const REMOTE_DIR = "/home/user/jarvis-video";
const WPM_FALLBACK = 150; // only used if a scene's TTS synth fails outright and a slide duration still has to be picked

function estimateSeconds(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, (words / WPM_FALLBACK) * 60);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function ensureFfmpeg() {
  const check = await Computer.desktopRunCommand("which ffmpeg");
  if (check.ok) return;
  const install = await Computer.desktopRunCommand("sudo apt-get update -y && sudo apt-get install -y ffmpeg", { timeoutMs: 180000 });
  if (!install.ok) throw new Error(`Couldn't install ffmpeg inside the sandbox: ${install.stderr || install.stdout}`);
}

function buildSlidesHtml(script, durationsMs) {
  const slides = script.scenes
    .map((s, i) => `<section class="slide" data-i="${i}"><h1>${escapeHtml(s.heading)}</h1></section>`)
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(script.title || "ad")}</title>
<style>
  html,body{margin:0;padding:0;background:#0b0b0f;color:#fff;font-family:'Helvetica Neue',Arial,sans-serif;overflow:hidden;height:100%;width:100%;}
  .slide{position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:8vw;background:linear-gradient(160deg,#151521,#0b0b0f);}
  .slide.active{display:flex;}
  h1{font-size:6vw;font-weight:800;line-height:1.15;text-shadow:0 4px 24px rgba(0,0,0,.5);}
</style></head>
<body>
${slides}
<script>
  const durations = ${JSON.stringify(durationsMs)};
  const slides = Array.from(document.querySelectorAll('.slide'));
  let i = 0;
  function show(n) { slides.forEach((el, idx) => el.classList.toggle('active', idx === n)); }
  function step() {
    show(i);
    const d = durations[i] || 3000;
    i++;
    if (i < slides.length) setTimeout(step, d);
  }
  step();
</script>
</body></html>`;
}

async function synthesizeScenes(scenes) {
  const clips = [];
  for (const scene of scenes) {
    let result = null;
    try { result = await TTS.synthesize(scene.narration); } catch { result = null; }
    if (!result) {
      clips.push({ buffer: null, mimeType: null, seconds: estimateSeconds(scene.narration) });
    } else {
      clips.push({ buffer: result.buffer, mimeType: result.mimeType, seconds: null });
    }
  }
  return clips;
}

/**
 * Produce a finished .mp4 for a video-script.js script.
 * @returns {Promise<{videoBuffer:Buffer, mimeType:string, seconds:number, failedScenes:number[]}>}
 */
async function produceVideo(script) {
  if (!Computer.isDesktopConfigured()) {
    throw new Error("E2B desktop sandbox isn't configured (E2B_API_KEY) — that's what Jarvis uses to record the screen for a video.");
  }
  if (!script || !Array.isArray(script.scenes) || !script.scenes.length) {
    throw new Error("produceVideo() needs a script with scenes (see video-script.js).");
  }

  await Computer.desktopRunCommand(`mkdir -p ${REMOTE_DIR}/audio`);
  await ensureFfmpeg();

  // 1. Narration first, so the slideshow can be timed to REAL clip
  // durations (measured via ffprobe) instead of a word-count guess.
  const clips = await synthesizeScenes(script.scenes);
  const durationsMs = [];
  const audioFiles = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (clip.buffer) {
      const ext = clip.mimeType && clip.mimeType.includes("flac") ? "flac" : "mp3";
      const remotePath = `${REMOTE_DIR}/audio/scene-${i}.${ext}`;
      await Computer.desktopWriteFile(remotePath, clip.buffer);
      const probe = await Computer.desktopRunCommand(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${remotePath}"`);
      const seconds = parseFloat(probe.stdout) || clip.seconds || estimateSeconds(script.scenes[i].narration);
      durationsMs.push(Math.round(seconds * 1000) + 400); // small pad between scenes
      audioFiles.push(remotePath);
    } else {
      durationsMs.push(Math.round(clip.seconds * 1000) + 400);
      audioFiles.push(null); // this scene's TTS failed — filled with silence below
    }
  }

  // 2. Concatenate narration (+ silence for any failed scene) into one track.
  const concatLines = [];
  for (let i = 0; i < audioFiles.length; i++) {
    if (audioFiles[i]) {
      concatLines.push(`file '${audioFiles[i]}'`);
    } else {
      const silencePath = `${REMOTE_DIR}/audio/silence-${i}.mp3`;
      await Computer.desktopRunCommand(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${(durationsMs[i] / 1000).toFixed(2)} "${silencePath}"`);
      concatLines.push(`file '${silencePath}'`);
    }
  }
  const concatListPath = `${REMOTE_DIR}/audio/concat.txt`;
  await Computer.desktopWriteFile(concatListPath, concatLines.join("\n"));
  const narrationPath = `${REMOTE_DIR}/narration.mp3`;
  const concatResult = await Computer.desktopRunCommand(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c:a libmp3lame -q:a 3 "${narrationPath}"`, { timeoutMs: 60000 });
  if (!concatResult.ok) throw new Error(`Couldn't build the narration track: ${concatResult.stderr || concatResult.stdout}`);

  // 3. Render + open the timed slideshow.
  const html = buildSlidesHtml(script, durationsMs);
  const htmlPath = `${REMOTE_DIR}/slides.html`;
  await Computer.desktopWriteFile(htmlPath, html);
  try {
    await Computer.desktopLaunch("google-chrome", `file://${htmlPath}`);
  } catch {
    await Computer.desktopLaunch("firefox", `file://${htmlPath}`);
  }
  await new Promise((r) => setTimeout(r, 2500)); // let the browser actually paint before recording starts

  // 4. Screen-record for the slideshow's total duration.
  const totalSeconds = Math.ceil(durationsMs.reduce((a, b) => a + b, 0) / 1000) + 1;
  const rawVideoPath = `${REMOTE_DIR}/raw.mp4`;
  const display = process.env.DESKTOP_DISPLAY || ":1"; // best-effort — see file header
  const recordResult = await Computer.desktopRunCommand(
    `ffmpeg -y -f x11grab -video_size 1280x720 -i ${display} -t ${totalSeconds} -pix_fmt yuv420p -r 30 "${rawVideoPath}"`,
    { timeoutMs: (totalSeconds + 30) * 1000 }
  );
  if (!recordResult.ok) {
    throw new Error(
      `Screen recording failed inside the sandbox: ${(recordResult.stderr || recordResult.stdout || "").slice(-500)}. ` +
      `Check the sandbox's real $DISPLAY (Computer.desktopRunCommand("echo $DISPLAY")) and set DESKTOP_DISPLAY to match if it's not :1.`
    );
  }

  // 5. Mux narration over the silent recording. -shortest guards
  // against a small drift between the estimate and the real capture
  // length leaving a silent or frozen tail.
  const finalPath = `${REMOTE_DIR}/final.mp4`;
  const muxResult = await Computer.desktopRunCommand(
    `ffmpeg -y -i "${rawVideoPath}" -i "${narrationPath}" -c:v copy -c:a aac -b:a 160k -shortest "${finalPath}"`,
    { timeoutMs: 60000 }
  );
  if (!muxResult.ok) throw new Error(`Couldn't mux narration into the video: ${muxResult.stderr || muxResult.stdout}`);

  const rawBytes = await Computer.desktopReadFile(finalPath);
  const videoBuffer = Buffer.from(rawBytes);
  const failedScenes = clips.map((c, i) => (c.buffer ? null : i)).filter((i) => i !== null);

  return { videoBuffer, mimeType: "video/mp4", seconds: totalSeconds, failedScenes };
}

module.exports = { produceVideo };
