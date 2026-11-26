import { useEffect, useRef } from "react";
import { Rive, RuntimeLoader, Layout, Fit, Alignment, type ViewModelInstance } from "@rive-app/webgl2";
import riveWasmUrl from "@rive-app/webgl2/rive.wasm?url";
import riveFallbackWasmUrl from "@rive-app/webgl2/rive_fallback.wasm?url";
import fleetSceneUrl from "@/assets/fleet/fleet-scene.riv?url";
import { createSceneBatcher, type SceneOp, type SceneState } from "./scene-model";

/** The Fleet scene drawn by the Rive runtime, from the designer's file
 *  (src/assets/fleet/fleet-scene.riv, contract in docs/FLEET_SCENE.md).
 *
 *  It draws only the scene: core, orbits, session nodes and their motion. The
 *  labels, cards and everything clickable are HTML laid over it. The app
 *  writes state changes as a diff; Rive animates between them on its own
 *  clock and, with settling on, stops drawing once nothing moves. */

// The runtime ships its wasm in the package; never fetch it from a CDN.
RuntimeLoader.setWasmUrl(riveWasmUrl);
RuntimeLoader.setWasmFallbackUrl(riveFallbackWasmUrl);

/** The artboard's size in the file; the app lays its labels out on the same
 *  geometry (see SCENE_RADIUS). */
export const SCENE_SIZE = { w: 1200, h: 720 };
/** Orbit radii in the file, in artboard units. */
export const SCENE_RADIUS = { needs: 130, working: 235, done: 335 } as const;

const argb = (hex: string) => (0xff000000 | parseInt(hex.replace("#", "").slice(0, 6), 16)) >>> 0;

interface Props {
  state: SceneState;
  /** Called once the file is loaded and drawing, or when it fails to load. */
  onReady?: (ok: boolean) => void;
}

export function RiveScene({ state, onReady }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const applyRef = useRef<((ops: SceneOp[]) => void) | null>(null);
  const batcherRef = useRef<ReturnType<typeof createSceneBatcher> | null>(null);
  const latest = useRef(state);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const items = new Map<string, ViewModelInstance>();
    let root: ViewModelInstance | null = null;

    const rive = new Rive({
      src: fleetSceneUrl,
      canvas,
      artboard: "FleetScene",
      stateMachine: "Main",
      autoplay: true,
      autoBind: false,
      enableSettling: true,
      layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
      onLoad: () => {
        rive.resizeDrawingSurfaceToCanvas();
        const vm = rive.viewModelByName("FleetScene");
        root = vm?.instance() ?? null;
        if (!root) { onReady?.(false); return; }
        rive.bindViewModelInstance(root);
        applyRef.current = apply;
        // Start from an empty scene so every session arrives through the diff.
        batcherRef.current = createSceneBatcher(ops => applyRef.current?.(ops), 150);
        batcherRef.current.push(latest.current);
        batcherRef.current.flush();
        onReady?.(true);
      },
      onLoadError: () => onReady?.(false),
    });

    const apply = (ops: SceneOp[]) => {
      if (!root) return;
      const list = root.list("sessions");
      const sessionVm = rive.viewModelByName("Session");
      for (const op of ops) {
        switch (op.op) {
          case "core": { const e = root.enum("core"); if (e) e.value = op.value; break; }
          case "motion": { const e = root.enum("motionLevel"); if (e) e.value = op.value; break; }
          case "append": {
            const inst = sessionVm?.instance();
            if (!inst || !list) break;
            const s = op.session;
            inst.string("id")!.value = s.id;
            inst.enum("phase")!.value = s.phase;
            inst.enum("ring")!.value = s.ring;
            inst.number("slotAngle")!.value = s.slotAngle;
            inst.number("activity")!.value = s.activity;
            inst.color("accent")!.value = argb(s.accent);
            list.addInstance(inst);
            items.set(s.id, inst);
            break;
          }
          case "remove": {
            const inst = items.get(op.id);
            if (inst && list) list.removeInstance(inst);
            items.delete(op.id);
            break;
          }
          case "set": {
            const inst = items.get(op.id);
            if (!inst) break;
            if (op.field === "phase" || op.field === "ring") inst.enum(op.field)!.value = op.value as string;
            else if (op.field === "slotAngle" || op.field === "activity") inst.number(op.field)!.value = op.value as number;
            else if (op.field === "accent") inst.color("accent")!.value = argb(op.value as string);
            break;
          }
          case "fire": {
            items.get(op.id)?.trigger(op.trigger)?.trigger();
            break;
          }
        }
      }
    };

    const ro = new ResizeObserver(() => rive.resizeDrawingSurfaceToCanvas());
    ro.observe(canvas);
    // Stop drawing while the window is hidden; catch up when it shows again.
    const onVis = () => {
      if (document.hidden) rive.pause();
      else { rive.play(); batcherRef.current?.flush(); }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      ro.disconnect();
      batcherRef.current?.dispose();
      batcherRef.current = null;
      applyRef.current = null;
      rive.cleanup();
    };
    // The file loads once per mount; state flows through the batcher below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    latest.current = state;
    batcherRef.current?.push(state);
  }, [state]);

  return <canvas ref={canvasRef} aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
}
