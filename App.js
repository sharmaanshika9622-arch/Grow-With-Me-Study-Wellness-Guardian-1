/**
 * app.js
 * ------
 * Grow-With-Me Study Wellness Guardian — browser version.
 *
 * Runs entirely in the browser using MediaPipe's Tasks Vision library
 * (loaded from a CDN as an ES module). No server, no Python, no data
 * ever leaves the device — everything happens frame-by-frame in memory.
 *
 * Two AI models run side by side:
 *   1. PoseLandmarker  -> tracks shoulder/ear position -> slouch angle
 *   2. FaceLandmarker  -> tracks face blendshapes -> blink detection
 *
 * The age profile (from profiles.js) decides how long bad posture or
 * a low blink rate is tolerated before an alert fires, and which
 * "voice" the alert uses.
 */

import {
  FilesetResolver,
  PoseLandmarker,
  FaceLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// ---------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------
const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const slouchStat = document.getElementById("slouchStat");
const blinkStat = document.getElementById("blinkStat");
const alertBox = document.getElementById("alertBox");
const summaryBox = document.getElementById("summaryBox");
const profileButtons = document.querySelectorAll(".profile-btn");

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let currentAgeGroup = "middle";
let poseLandmarker = null;
let faceLandmarker = null;
let running = false;
let rafId = null;

let slouchStartTime = null;
let lastAlertTime = 0;
const ALERT_COOLDOWN_MS = 8000;

let sessionStartTime = null;
let posturealertCount = 0;
let eyeAlertCount = 0;

// Rolling blink timestamps (ms) for blinks-per-minute calculation
let blinkTimestamps = [];
let eyeWasClosed = false;
const BLINK_WINDOW_MS = 60000;
const BLINK_SCORE_THRESHOLD = 0.5; // blendshape score above this = eye considered closed

// ---------------------------------------------------------------------
// Age profile selector
// ---------------------------------------------------------------------
profileButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentAgeGroup = btn.dataset.age;
    profileButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

// ---------------------------------------------------------------------
// Model setup
// ---------------------------------------------------------------------
async function setupModels() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });

  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
}

// ---------------------------------------------------------------------
// Webcam setup
// ---------------------------------------------------------------------
async function setupWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: false,
  });
  video.srcObject = stream;
  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      resolve();
    };
  });
}

// ---------------------------------------------------------------------
// Posture: angle between shoulder->ear line and vertical
// ---------------------------------------------------------------------
function calculateSlouchAngle(shoulder, ear) {
  const dx = ear.x - shoulder.x;
  const dy = ear.y - shoulder.y;
  const angleRad = Math.atan2(Math.abs(dx), Math.abs(dy) || 1e-6);
  return (angleRad * 180) / Math.PI;
}

// ---------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------
function showAlert(message) {
  alertBox.textContent = message;
  alertBox.classList.add("visible");
  clearTimeout(showAlert._timer);
  showAlert._timer = setTimeout(() => {
    alertBox.classList.remove("visible");
  }, 5000);
}

// ---------------------------------------------------------------------
// Main detection loop
// ---------------------------------------------------------------------
function detectFrame() {
  if (!running) return;

  const now = performance.now();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const profile = getProfile(currentAgeGroup);

  // ---------- POSE (posture) ----------
  const poseResult = poseLandmarker.detectForVideo(video, now);
  let angle = null;

  if (poseResult.landmarks && poseResult.landmarks.length > 0) {
    const lm = poseResult.landmarks[0];
    // MediaPipe Pose landmark indices: 12 = right shoulder, 8 = right ear
    const shoulder = lm[12];
    const ear = lm[8];

    if (shoulder && ear) {
      angle = calculateSlouchAngle(shoulder, ear);

      // draw the two points + connecting line for visual feedback
      drawPoint(shoulder, "#e8c468");
      drawPoint(ear, "#e08a6a");
      drawLine(shoulder, ear, "#8fb8c9");

      const slouching = angle > 20; // degrees threshold
      const nowMs = Date.now();

      if (slouching) {
        if (slouchStartTime === null) slouchStartTime = nowMs;
        const duration = (nowMs - slouchStartTime) / 1000;

        if (
          duration > profile.maxSlouchSeconds &&
          nowMs - lastAlertTime > ALERT_COOLDOWN_MS
        ) {
          showAlert(getMessage(currentAgeGroup, "posture"));
          lastAlertTime = nowMs;
          posturealertCount++;
          slouchStartTime = nowMs; // reset window
        }
      } else {
        slouchStartTime = null;
      }
    }
  }
  slouchStat.textContent = angle !== null ? `${angle.toFixed(1)}°` : "—";

  // ---------- FACE (blink / eye strain) ----------
  const faceResult = faceLandmarker.detectForVideo(video, now);
  if (
    faceResult.faceBlendshapes &&
    faceResult.faceBlendshapes.length > 0
  ) {
    const categories = faceResult.faceBlendshapes[0].categories;
    const blinkLeft = categories.find((c) => c.categoryName === "eyeBlinkLeft");
    const blinkRight = categories.find((c) => c.categoryName === "eyeBlinkRight");

    if (blinkLeft && blinkRight) {
      const avgScore = (blinkLeft.score + blinkRight.score) / 2;
      const isClosed = avgScore > BLINK_SCORE_THRESHOLD;
      const nowMs = Date.now();

      // detect closed -> open transition as one completed blink
      if (eyeWasClosed && !isClosed) {
        blinkTimestamps.push(nowMs);
      }
      eyeWasClosed = isClosed;

      // drop timestamps outside the rolling window
      blinkTimestamps = blinkTimestamps.filter(
        (t) => nowMs - t <= BLINK_WINDOW_MS
      );

      const blinkRate = blinkTimestamps.length * (60000 / BLINK_WINDOW_MS);
      blinkStat.textContent = `${blinkRate.toFixed(1)}/min`;

      const elapsedSec = (nowMs - sessionStartTime) / 1000;
      if (
        elapsedSec > 20 &&
        blinkRate < profile.minBlinkRate &&
        nowMs - lastAlertTime > ALERT_COOLDOWN_MS
      ) {
        showAlert(getMessage(currentAgeGroup, "eyeStrain"));
        lastAlertTime = nowMs;
        eyeAlertCount++;
      }
    }
  }

  rafId = requestAnimationFrame(detectFrame);
}

function drawPoint(point, color) {
  ctx.beginPath();
  ctx.arc(point.x * canvas.width, point.y * canvas.height, 6, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawLine(p1, p2, color) {
  ctx.beginPath();
  ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
  ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ---------------------------------------------------------------------
// Start / stop session
// ---------------------------------------------------------------------
async function startSession() {
  startBtn.disabled = true;
  statusEl.textContent = "Loading AI models…";

  try {
    if (!poseLandmarker || !faceLandmarker) {
      await setupModels();
    }
    await setupWebcam();
  } catch (err) {
    statusEl.textContent =
      "Could not access webcam or load models. Check camera permissions and your connection.";
    startBtn.disabled = false;
    console.error(err);
    return;
  }

  // reset session state
  slouchStartTime = null;
  lastAlertTime = 0;
  blinkTimestamps = [];
  eyeWasClosed = false;
  posturealertCount = 0;
  eyeAlertCount = 0;
  sessionStartTime = Date.now();

  running = true;
  statusEl.textContent = `Session running — ${getProfile(currentAgeGroup).label}`;
  summaryBox.classList.remove("visible");
  stopBtn.disabled = false;
  detectFrame();
}

function stopSession() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);

  const stream = video.srcObject;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.textContent = "Session ended.";

  const minutes = ((Date.now() - sessionStartTime) / 60000).toFixed(1);
  const noAlerts = posturealertCount === 0 && eyeAlertCount === 0;
  summaryBox.innerHTML = `
    <strong>Session summary</strong> — ${getProfile(currentAgeGroup).label}<br>
    Length: ${minutes} min &nbsp;|&nbsp; Posture alerts: ${posturealertCount} &nbsp;|&nbsp; Eye-strain alerts: ${eyeAlertCount}<br>
    ${noAlerts ? getMessage(currentAgeGroup, "goodSession") : ""}
  `;
  summaryBox.classList.add("visible");
}

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
