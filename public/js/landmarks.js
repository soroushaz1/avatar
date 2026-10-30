// MediaPipe Face Mesh landmark indices used to animate the avatars.
// "A" is the side that appears on the left of the un-mirrored camera image, "B" the right.

export const LIP_UPPER_OUTER = [185, 40, 39, 37, 0, 267, 269, 270, 409];
export const LIP_LOWER_OUTER = [146, 91, 181, 84, 17, 314, 405, 321, 375];
export const LIP_UPPER_INNER = [191, 80, 81, 82, 13, 312, 311, 310, 415];
export const LIP_LOWER_INNER = [95, 88, 178, 87, 14, 317, 402, 318, 324];
export const MOUTH_CORNERS_OUTER = [61, 291];
export const MOUTH_CORNERS_INNER = [78, 308];

// Inner mouth contour as a closed polygon (corner A -> upper lip -> corner B -> lower lip).
export const MOUTH_INNER_POLYGON = [78, ...LIP_UPPER_INNER, 308, ...LIP_LOWER_INNER.slice().reverse()];

// Upper eyelid points paired with the lower eyelid point below each of them, plus the
// crease row above the lid that follows it partially when blinking.
export const EYE_A = {
  upper: [246, 161, 160, 159, 158, 157, 173],
  lower: [7, 163, 144, 145, 153, 154, 155],
  crease: [247, 30, 29, 27, 28, 56, 190],
  corners: [33, 133],
};
export const EYE_B = {
  upper: [466, 388, 387, 386, 385, 384, 398],
  lower: [249, 390, 373, 374, 380, 381, 382],
  crease: [467, 260, 259, 257, 258, 286, 414],
  corners: [263, 362],
};

export const BROW_A = [70, 63, 105, 66, 107, 46, 53, 52, 65, 55];
export const BROW_B = [300, 293, 334, 296, 336, 276, 283, 282, 295, 285];

export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

export const FOREHEAD = 10;
export const CHIN = 152;
export const CHEEK_A = 234;
export const CHEEK_B = 454;
export const NOSE_TIP = 1;
export const FACE_POINT_COUNT = 468; // iris points (468-477) are not used
