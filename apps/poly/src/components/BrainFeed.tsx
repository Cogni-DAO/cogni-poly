"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  BrainCircuit,
  ChevronRight,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

/* ─── Types — mirrors future Zod schema from langgraph ── */

interface MarketSignal {
  id: string;
  market: string;
  platform: "Polymarket" | "Kalshi" | "Manifold";
  category: string;
  probability: number;
  direction: "bullish" | "bearish";
  confidence: number;
  thesis: string;
  sources: string[];
  timestamp: string;
}

interface BrainStatus {
  state: "scanning" | "analyzing" | "idle";
  marketsScanned: number;
  signalsGenerated: number;
  lastHeartbeat: string;
}

const INITIAL_STATUS: BrainStatus = {
  state: "idle",
  marketsScanned: 0,
  signalsGenerated: 0,
  lastHeartbeat: "",
};

/* ─── Heartbeat indicator ───────────────────────── */

function HeartbeatDot({
  state,
}: {
  state: BrainStatus["state"];
}): ReactElement {
  return (
    <span className="relative flex size-2.5">
      <span
        className={`absolute inline-flex size-full animate-ping rounded-full opacity-75 ${
          state === "scanning"
            ? "bg-up"
            : state === "analyzing"
              ? "bg-primary"
              : "bg-muted-foreground"
        }`}
      />
      <span
        className={`relative inline-flex size-2.5 rounded-full ${
          state === "scanning"
            ? "bg-up"
            : state === "analyzing"
              ? "bg-primary"
              : "bg-muted-foreground"
        }`}
      />
    </span>
  );
}

/* ─── Single signal card ────────────────────────── */

function SignalCard({
  signal,
  index,
}: {
  signal: MarketSignal;
  index: number;
}): ReactElement {
  const isBullish = signal.direction === "bullish";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.08 }}
      className="group rounded-lg border border-border/40 bg-card p-4 transition-colors hover:border-border/80"
    >
      {/* Header */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              {signal.category}
            </span>
            <span className="text-[10px] text-muted-foreground/40">
              {signal.platform}
            </span>
            <span className="text-[10px] text-muted-foreground/30">
              {signal.timestamp}
            </span>
          </div>
          <h4 className="font-medium text-foreground text-sm leading-snug">
            {signal.market}
          </h4>
        </div>

        {/* Direction + confidence */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
              isBullish ? "bg-up/10 text-up" : "bg-down/10 text-down"
            }`}
          >
            {isBullish ? (
              <TrendingUp className="size-2.5" />
            ) : (
              <TrendingDown className="size-2.5" />
            )}
            {signal.direction}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {signal.confidence}% conf
          </span>
        </div>
      </div>

      {/* Thesis */}
      <p className="mb-2 text-muted-foreground text-xs leading-relaxed">
        {signal.thesis}
      </p>

      {/* Sources */}
      <div className="flex flex-wrap gap-1">
        {signal.sources.map((src) => (
          <span
            key={src}
            className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground/70"
          >
            {src}
          </span>
        ))}
      </div>
    </motion.div>
  );
}

/* ─── Exported section ──────────────────────────── */

export function BrainFeed(): ReactElement {
  const [status, setStatus] = useState<BrainStatus>(INITIAL_STATUS);
  const [signals, setSignals] = useState<MarketSignal[]>([]);
  const [visibleSignals, setVisibleSignals] = useState(2);

  // Fetch status on interval
  useEffect(() => {
    async function fetchStatus(): Promise<void> {
      try {
        const res = await fetch("/api/v1/poly/status");
        if (res.ok) {
          const data = (await res.json()) as { status: BrainStatus };
          setStatus(data.status);
        }
      } catch {
        // Silently retry on next interval
      }
    }
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 10_000);
    return () => clearInterval(interval);
  }, []);

  // Fetch signals
  useEffect(() => {
    async function fetchSignals(): Promise<void> {
      try {
        const res = await fetch("/api/v1/poly/signals");
        if (res.ok) {
          const data = (await res.json()) as { signals: MarketSignal[] };
          setSignals(data.signals);
        }
      } catch {
        // Silently retry on next interval
      }
    }
    void fetchSignals();
    const interval = setInterval(() => void fetchSignals(), 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="w-full border-border/40 border-t bg-background py-20 md:py-28">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="mb-8"
        >
          <span className="font-mono text-primary text-xs uppercase tracking-widest">
            Brain activity
          </span>
          <h2 className="mt-3 font-bold text-3xl tracking-tight sm:text-4xl">
            What the bot is thinking.
          </h2>
          <p className="mt-3 max-w-lg text-muted-foreground">
            Live output from Cogni&apos;s analysis engine. Every signal is
            public — see exactly what it sees and why.
          </p>
        </motion.div>

        {/* Status bar */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="mb-6 flex flex-wrap items-center gap-4 rounded-lg border border-border/40 bg-card p-3 sm:gap-6 sm:p-4"
        >
          <div className="flex items-center gap-2">
            <HeartbeatDot state={status.state} />
            <span className="font-mono text-xs uppercase tracking-wider">
              {status.state === "scanning" && (
                <span className="text-up">Scanning</span>
              )}
              {status.state === "analyzing" && (
                <span className="text-primary">Analyzing</span>
              )}
              {status.state === "idle" && (
                <span className="text-muted-foreground">Idle</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Activity className="size-3" />
            <span className="font-mono text-xs tabular-nums">
              {status.marketsScanned.toLocaleString()} markets
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <BrainCircuit className="size-3" />
            <span className="font-mono text-xs tabular-nums">
              {status.signalsGenerated} signals today
            </span>
          </div>
        </motion.div>

        {/* Signal feed */}
        <div className="space-y-3">
          <AnimatePresence>
            {signals.slice(0, visibleSignals).map((signal, i) => (
              <SignalCard key={signal.id} signal={signal} index={i} />
            ))}
          </AnimatePresence>
        </div>

        {/* Show more */}
        {visibleSignals < signals.length && (
          <motion.button
            type="button"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            onClick={() => setVisibleSignals(signals.length)}
            className="mt-4 flex w-full items-center justify-center gap-1 rounded-lg border border-border/40 bg-card py-3 font-mono text-muted-foreground text-xs uppercase tracking-wider transition-colors hover:border-border/80 hover:text-foreground"
          >
            Show {signals.length - visibleSignals} more signals
            <ChevronRight className="size-3" />
          </motion.button>
        )}
      </div>
    </section>
  );
}
