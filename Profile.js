/**
 * profiles.js
 * ------------
 * The "Grow-With-Me" brain of the project — same logic as the original
 * Python version (age_profiles.py), ported to JS so it can run in the
 * browser.
 *
 * Each profile defines how tolerant the system is before it alerts,
 * and which "voice" it uses to talk to the student.
 */

const AGE_PROFILES = {
  lower: {
    key: "lower",
    label: "Lower Classes (5–9 yrs)",
    maxSlouchSeconds: 20,
    maxScreenStareSeconds: 90,
    minBlinkRate: 12, // blinks per minute
    messageStyle: "playful",
  },
  middle: {
    key: "middle",
    label: "Middle Classes (10–14 yrs)",
    maxSlouchSeconds: 40,
    maxScreenStareSeconds: 150,
    minBlinkRate: 10,
    messageStyle: "habit",
  },
  higher: {
    key: "higher",
    label: "Higher Classes (15–18 yrs)",
    maxSlouchSeconds: 60,
    maxScreenStareSeconds: 240,
    minBlinkRate: 8,
    messageStyle: "analytical",
  },
};

const MESSAGES = {
  playful: {
    posture: "Buddy the Bear says: sit up tall like a superhero! 🦸",
    eyeStrain: "Blink, blink! Your eyes want a little rest. Look far away for 10 seconds!",
    goodSession: "Wow, great sitting today! You're a study star! ⭐",
  },
  habit: {
    posture: "Posture check: you've been slouching a bit. Straighten up — small habits add up!",
    eyeStrain: "Your eyes have been on the screen a while. Try the 20-20-20 rule: look 20 feet away for 20 seconds.",
    goodSession: "Nice work — you kept steady posture for this whole session. Keep the habit going!",
  },
  analytical: {
    posture: "Posture alert: spine angle has been outside the healthy range for a while. Consider adjusting your seating.",
    eyeStrain: "Blink rate has dropped below the healthy threshold, indicating early eye strain. A short break is recommended.",
    goodSession: "Session summary: posture and eye-strain metrics stayed within healthy range throughout.",
  },
};

function getProfile(ageGroupKey) {
  const profile = AGE_PROFILES[ageGroupKey];
  if (!profile) throw new Error(`Unknown age group: ${ageGroupKey}`);
  return profile;
}

function getMessage(ageGroupKey, event) {
  const profile = getProfile(ageGroupKey);
  return MESSAGES[profile.messageStyle][event];
}
