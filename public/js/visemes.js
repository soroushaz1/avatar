// Visemes: the distinct mouth shapes of speech. Every sound (phoneme) maps to one of them, and the
// avatars keep one image per viseme (generated for the 3D character, captured from the camera for the
// realistic avatar). "PP" (closed lips) is the portrait itself.

export const VISEME_IDS = ['FF', 'SS', 'E', 'AA', 'AW', 'I', 'O', 'U'];

// Mouth parameters per viseme, used when no image exists for it (the warped, painted mouth).
export const VISEME_PARAMS = {
  PP: { jawOpen: 0, wide: 0.05, pucker: 0.1 },
  FF: { jawOpen: 0.07, wide: 0.35, pucker: 0 },
  SS: { jawOpen: 0.1, wide: 0.45, pucker: 0 },
  E: { jawOpen: 0.36, wide: 0.4, pucker: 0 },
  AA: { jawOpen: 0.62, wide: 0.2, pucker: 0 },
  AW: { jawOpen: 0.7, wide: 0, pucker: 0.25 },
  I: { jawOpen: 0.22, wide: 0.8, pucker: 0 },
  O: { jawOpen: 0.42, wide: 0, pucker: 0.6 },
  U: { jawOpen: 0.15, wide: 0, pucker: 0.9 },
};

// When an image is missing, the closest shape that exists is used instead.
export const VISEME_FALLBACK = {
  FF: ['SS', 'PP'],
  SS: ['I', 'E', 'PP'],
  E: ['AA', 'I', 'SS'],
  AA: ['AW', 'E'],
  AW: ['AA', 'O'],
  I: ['E', 'SS'],
  O: ['U', 'AW', 'AA'],
  U: ['O', 'PP'],
};

// IPA phoneme (as produced by espeak/Piper) -> [viseme, strength, kind]. 'rest' closes the mouth,
// null means "no shape of its own" (stress/length marks, gaps between words).
// kind: 'v' vowel, 'c' consonant made with the lips or teeth, 'w' consonant made inside the mouth
// (t, k, h...), whose lip shape mostly comes from the neighbouring vowel.
export function visemeOfPhoneme(ph) {
  if (/^[,.!?;:^$—–-]/.test(ph)) return ['rest', 1, 'c'];
  if (/^[mbp]/.test(ph)) return ['PP', 1, 'c'];
  if (/^[fv]/.test(ph)) return ['FF', 1, 'c'];
  if (/^(tʃ|dʒ|ʃ|ʒ)/.test(ph)) return ['U', 0.55, 'c'];
  if (/^[θð]/.test(ph)) return ['SS', 0.8, 'c'];
  if (/^[szʦʣ]/.test(ph)) return ['SS', 1, 'c'];
  if (/^[tdnlɫ]/.test(ph)) return ['SS', 0.6, 'w'];
  if (/^[rɹɾʁ]/.test(ph)) return ['U', 0.4, 'w'];
  if (/^w/.test(ph)) return ['U', 0.9, 'c'];
  if (/^j/.test(ph)) return ['I', 0.6, 'w'];
  if (/^[kgŋxɣqχhɦʔɢ]/.test(ph)) return ['E', 0.45, 'w'];
  if (/^[ɑɒ]/.test(ph)) return ['AW', 1, 'v'];
  if (/^ʌ/.test(ph)) return ['AA', 0.8, 'v'];
  if (/^[aæɐä]/.test(ph)) return ['AA', 1, 'v'];
  if (/^ə/.test(ph)) return ['E', 0.7, 'v'];
  if (/^[eɛɘɜ]/.test(ph)) return ['E', 1, 'v'];
  if (/^ɪ/.test(ph)) return ['I', 0.8, 'v'];
  if (/^[iy]/.test(ph)) return ['I', 1, 'v'];
  if (/^[oɔɵœ]/.test(ph)) return ['O', 1, 'v'];
  if (/^[uʊʉɯø]/.test(ph)) return ['U', 1, 'v'];
  if (/^[\p{Ll}\p{Lo}]/u.test(ph)) return ['E', 0.4, 'w'];
  return null;
}

// Classifies the user's mouth (MediaPipe blendshape scores) into a viseme, or null for closed/neutral.
export function visemeOfBlendshapes(b) {
  const avg = (l, r) => ((b[l] || 0) + (b[r] || 0)) / 2;
  const jaw = b.jawOpen || 0, funnel = b.mouthFunnel || 0, pucker = b.mouthPucker || 0;
  const spread = avg('mouthStretchLeft', 'mouthStretchRight') + avg('mouthSmileLeft', 'mouthSmileRight');
  const teeth = avg('mouthUpperUpLeft', 'mouthUpperUpRight') + avg('mouthLowerDownLeft', 'mouthLowerDownRight');
  if (jaw > 0.42) return funnel > 0.22 ? 'AW' : 'AA';
  if (pucker > 0.45 && jaw < 0.2) return 'U';
  if (funnel > 0.28 && jaw >= 0.12) return 'O';
  if ((b.mouthRollLower || 0) > 0.35 && jaw < 0.18) return 'FF';
  if (jaw >= 0.16) return spread > 0.35 ? 'I' : 'E';
  if (spread > 0.4 && teeth > 0.2) return 'I';
  if (teeth > 0.22) return 'SS';
  return null;
}

// How far the mouth is into the shape it was classified as (0..1), for mirroring it on the character.
export function visemeStrength(id, b) {
  if (id === 'FF' || id === 'SS' || id === 'U') return 1;
  return Math.min(1, 0.5 + (b.jawOpen || 0));
}
