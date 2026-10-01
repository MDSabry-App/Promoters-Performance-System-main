export type AchievementTone = "danger" | "warn" | "good";

export type AchievementStatus = {
  /** 0-100 (capped) value used to draw the progress ring */
  progress: number;
  /** colour bucket of the ring + label */
  tone: AchievementTone;
  /** short word shown inside the ring */
  label: "Bad" | "Normal" | "Good" | "Excellent";
};

/**
 * Maps a sales achievement percentage to how the progress circle should look:
 *   0  - 60  -> red ring,    "Bad"
 *   61 - 85  -> yellow ring, "Normal"
 *   86 - 100 -> green ring,  "Good"
 *   above 100 -> green ring, "Excellent"
 */
export function achievementStatus(achievement: number): AchievementStatus {
  const value = Number.isFinite(achievement) ? achievement : 0;
  const progress = Math.max(0, Math.min(100, value));
  if (value <= 60) return { progress, tone: "danger", label: "Bad" };
  if (value <= 85) return { progress, tone: "warn", label: "Normal" };
  if (value <= 100) return { progress, tone: "good", label: "Good" };
  return { progress: 100, tone: "good", label: "Excellent" };
}