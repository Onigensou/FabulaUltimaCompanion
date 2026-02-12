import { registerIdleAnimTokenConfigTab } from "./idle-animation-configTab.js";
import { OniIdleAnimManager } from "./idle-animation-manager.js";

export function registerIdleAnimSystem() {
  // 1) Inject the tab
  registerIdleAnimTokenConfigTab();

  // 2) Apply animations when tokens update (SYNC across all clients via document updates)
  Hooks.on("updateToken", async (doc) => {
    try {
      await OniIdleAnimManager.applyFromDoc(doc);
    } catch (e) {
      console.error("[ONI][IdleAnim] updateToken apply failed", e);
    }
  });

  // 3) On canvas ready, apply animations to everything already on the scene
  Hooks.on("canvasReady", async () => {
    try {
      await OniIdleAnimManager.applyAllOnCanvas();
    } catch (e) {
      console.error("[ONI][IdleAnim] canvasReady applyAll failed", e);
    }
  });
}
