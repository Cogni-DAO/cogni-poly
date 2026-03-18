// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

"use client";

import { motion } from "framer-motion";
import { ArrowRight, Zap } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components";

import { useTryDemo } from "../hooks/useTryDemo";

function PulseRing(): ReactElement {
  return (
    <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="absolute rounded-full border border-primary/20"
          style={{
            width: `${320 + i * 180}px`,
            height: `${320 + i * 180}px`,
            top: `${-(160 + i * 90)}px`,
            left: `${-(160 + i * 90)}px`,
            animation: `pulse-ring 4s ease-out ${i * 1.2}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

function LatencyCounter(): ReactElement {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setMs((prev) => {
        if (prev >= 1200) return 0;
        return prev + Math.floor(Math.random() * 80) + 20;
      });
    }, 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="inline-flex items-center gap-2 font-mono text-sm tracking-widest">
      <span
        className="inline-block size-2 rounded-full"
        style={{ backgroundColor: "hsl(45, 90%, 55%)" }}
      />
      <span className="text-muted-foreground">
        {String(ms).padStart(4, "0")}
        <span className="opacity-60">ms</span>
      </span>
    </span>
  );
}

export function NewHomeHero(): ReactElement {
  const { handleTryDemo } = useTryDemo();

  return (
    <section className="relative flex min-h-[90vh] w-full flex-col items-center justify-center overflow-hidden bg-background px-4 sm:px-6">
      {/* Background grid */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
        }}
      />

      {/* Pulse rings */}
      <PulseRing />

      {/* Top accent line */}
      <div
        className="absolute top-0 left-1/2 h-px w-1/2 -translate-x-1/2"
        style={{
          background:
            "linear-gradient(90deg, transparent, hsl(45 90% 55% / 0.4), transparent)",
        }}
      />

      {/* Content */}
      <div className="relative z-10 mx-auto max-w-4xl text-center">
        {/* Status bar */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-8 inline-flex items-center gap-3 rounded-full border border-border/60 px-4 py-2"
        >
          <Zap className="size-3.5" style={{ color: "hsl(45, 90%, 55%)" }} />
          <span className="text-muted-foreground text-xs uppercase tracking-[0.2em]">
            Watching for openings
          </span>
          <LatencyCounter />
        </motion.div>

        {/* Main headline */}
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="font-bold text-4xl leading-[1.1] tracking-tight sm:text-6xl lg:text-7xl"
        >
          <span className="text-foreground">Your table.</span>
          <br />
          <span
            style={{
              background: "linear-gradient(135deg, hsl(45, 90%, 55%), hsl(35, 95%, 65%))",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Not theirs.
          </span>
        </motion.h1>

        {/* Subhead */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground sm:text-xl"
        >
          Stop losing reservations to scalper bots.
          <br className="hidden sm:block" />{" "}
          We claim your table in seconds, using official channels only.
        </motion.p>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.35 }}
          className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
        >
          <Button size="lg" onClick={handleTryDemo}>
            Get started
            <ArrowRight className="ml-2 size-4" />
          </Button>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.15em]">
            One account. One table. No scalping.
          </span>
        </motion.div>
      </div>

      {/* Keyframe styles */}
      <style>{`
        @keyframes pulse-ring {
          0% { opacity: 0.6; transform: scale(0.8); }
          100% { opacity: 0; transform: scale(1.4); }
        }
      `}</style>
    </section>
  );
}
