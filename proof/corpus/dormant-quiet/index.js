// SYNTHETIC. Pure dormant: does nothing observable at all. The hardest malicious case — only the
// clock/CI/wallet provocations would ever move a real one; this one never acts, so it should NOT be
// flagged, and counts as a miss for detection. Kept honest: not every stealer is catchable.
module.exports = 1;
