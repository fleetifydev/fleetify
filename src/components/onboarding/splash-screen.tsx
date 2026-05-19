import { useEffect, useState } from "react";
import { LogoMark } from "@/components/brand/logo-mark";

interface SplashScreenProps {
  onDone: () => void;
}

/**
 * Splash — single element, dead-center on the solid app background.
 * The whole surface is a drag region; there are no controls to no-drag.
 */
export function SplashScreen({ onDone }: SplashScreenProps) {
  const [show, setShow] = useState(false);
  const [exit, setExit] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setShow(true), 80);
    const t2 = setTimeout(() => setExit(true), 1500);
    const t3 = setTimeout(() => onDone(), 1900);
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
    };
  }, [onDone]);

  return (
    <div
      className="app-drag"
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        opacity: exit ? 0 : 1,
        transition: "opacity 0.4s ease",
      }}
    >
      <LogoMark
        size={64}
        color="var(--m-text)"
        style={{
          opacity: show ? 1 : 0,
          transform: show ? "scale(1)" : "scale(0.96)",
          transition: "opacity 0.7s ease, transform 0.7s cubic-bezier(0.16,1,0.3,1)",
        }}
      />
    </div>
  );
}
