import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { getProviderStats, resetProviderStats } from "../api/stats";
import { Button, cn, Dialog, EmptyState, Spinner, Toolbar } from "../components/ui";
import type { ProviderStats } from "../types";

/**
 * Each provider keeps one color however many slices there are, so a provider's color never
 * changes when another drops out. Slots 1-4 of the chart palette (tokens.css).
 */
const PROVIDER_COLOR: Record<string, string> = {
  "real-debrid": "var(--color-series-1)",
  alldebrid: "var(--color-series-2)",
  torbox: "var(--color-series-3)",
  premiumize: "var(--color-series-4)",
};
const colorOf = (provider: string) => PROVIDER_COLOR[provider] ?? "var(--color-idle)";

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** SVG path of one pie slice from `start` to `end` (fractions of a turn, 0 = 12 o'clock). */
function slicePath(start: number, end: number, r: number, c: number) {
  const point = (f: number) => {
    const a = 2 * Math.PI * f - Math.PI / 2;
    return `${c + r * Math.cos(a)} ${c + r * Math.sin(a)}`;
  };
  const large = end - start > 0.5 ? 1 : 0;
  return `M ${c} ${c} L ${point(start)} A ${r} ${r} 0 ${large} 1 ${point(end)} Z`;
}

const SIZE = 220;
const RADIUS = 104;
const CENTER = SIZE / 2;

function HitsPie({ stats, hovered, onHover }: {
  stats: ProviderStats[];
  hovered: string | null;
  onHover(provider: string | null): void;
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const slices = stats.filter((s) => s.hits > 0);
  const total = slices.reduce((n, s) => n + s.hits, 0);
  let at = 0;
  const shapes = slices.map((s) => {
    const start = at;
    at += s.hits / total;
    return { s, start, end: at };
  });
  const active = slices.find((s) => s.provider === hovered);

  const move = (e: MouseEvent<SVGElement>, provider: string) => {
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (box) setTip({ x: e.clientX - box.left, y: e.clientY - box.top });
    onHover(provider);
  };

  return (
    <div className="relative shrink-0" onMouseLeave={() => { setTip(null); onHover(null); }}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`Hits by provider: ${slices.map((s) => `${s.name} ${s.hits} (${percent(s.hits, total)}%)`).join(", ")}`}
      >
        {shapes.map(({ s, start, end }) => {
          const dim = hovered !== null && hovered !== s.provider;
          const common = {
            fill: colorOf(s.provider),
            // A surface-colored edge leaves a gap between neighbouring slices.
            stroke: "var(--color-bg)",
            strokeWidth: 2,
            strokeLinejoin: "round" as const,
            opacity: dim ? 0.35 : 1,
            className: "transition-opacity duration-120",
            onMouseMove: (e: MouseEvent<SVGElement>) => move(e, s.provider),
          };
          return slices.length === 1 ? (
            <circle key={s.provider} cx={CENTER} cy={CENTER} r={RADIUS} {...common} />
          ) : (
            <path key={s.provider} d={slicePath(start, end, RADIUS, CENTER)} {...common} />
          );
        })}
      </svg>
      {active && tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-sm shadow-panel"
          style={{ left: tip.x + 12, top: tip.y + 12 }}
        >
          <div className="font-semibold text-fg">{active.name}</div>
          <div className="text-fg-secondary tabular">
            {active.hits} {active.hits === 1 ? "hit" : "hits"} · {percent(active.hits, total)}%
          </div>
        </div>
      )}
    </div>
  );
}

export default function StatisticsPage() {
  const [stats, setStats] = useState<ProviderStats[] | null>(null);
  const [error, setError] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    try {
      setStats(await getProviderStats());
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Adds made elsewhere (drop, watch list) show up when the list refreshes.
  useEffect(() => {
    window.addEventListener("refresh-list", load);
    return () => window.removeEventListener("refresh-list", load);
  }, [load]);

  const handleReset = async () => {
    setResetting(true);
    try {
      await resetProviderStats();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  };

  const totalHits = stats?.reduce((n, s) => n + s.hits, 0) ?? 0;
  const totalTries = stats?.reduce((n, s) => n + s.hits + s.misses, 0) ?? 0;
  // Providers never tried stay out of the breakdown.
  const tried = (stats ?? []).filter((s) => s.hits + s.misses > 0);

  return (
    <>
      <Toolbar
        title="Statistics"
        subtitle={stats ? `${totalHits} ${totalHits === 1 ? "torrent" : "torrents"} added` : undefined}
        actions={
          <Button onClick={() => setConfirmReset(true)} disabled={totalTries === 0}>
            Reset…
          </Button>
        }
      />
      {error && <div className="border-b border-border px-4 py-2 text-sm text-danger">{error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {stats === null ? (
          <div className="flex justify-center py-24"><Spinner /></div>
        ) : totalTries === 0 ? (
          <EmptyState
            title="No statistics yet"
            hint="Each time you add a magnet or torrent, the provider that takes it counts as a hit."
          />
        ) : (
          <section className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            <div>
              <h2 className="text-md font-semibold text-fg">Hits by provider</h2>
              <p className="text-sm text-fg-muted">
                Which provider took each magnet or torrent you added. A provider that refused one (not cached,
                too big, ...) counts a miss, and the next provider in line was tried.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-8">
              {totalHits > 0 ? (
                <HitsPie stats={stats} hovered={hovered} onHover={setHovered} />
              ) : (
                <p className="text-sm text-fg-muted">No provider has taken a torrent yet.</p>
              )}

              <table className="min-w-0 flex-1 text-base" aria-label="Hits and misses by provider">
                <thead>
                  <tr className="text-left text-sm text-fg-muted">
                    <th className="pb-2 font-normal">Provider</th>
                    <th className="pb-2 text-right font-normal">Hits</th>
                    <th className="pb-2 text-right font-normal">Share</th>
                    <th className="pb-2 text-right font-normal">Misses</th>
                    <th className="pb-2 text-right font-normal">Hit rate</th>
                  </tr>
                </thead>
                <tbody>
                  {tried.map((s) => (
                    <tr
                      key={s.provider}
                      onMouseEnter={() => setHovered(s.provider)}
                      onMouseLeave={() => setHovered(null)}
                      className={cn("border-t border-border-subtle", hovered === s.provider && "bg-raised")}
                    >
                      <td className="py-1.5">
                        <span className="flex items-center gap-2 text-fg">
                          <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: colorOf(s.provider) }} />
                          {s.name}
                        </span>
                      </td>
                      <td className="py-1.5 text-right text-fg tabular">{s.hits}</td>
                      <td className="py-1.5 text-right text-fg-secondary tabular">{percent(s.hits, totalHits)}%</td>
                      <td className="py-1.5 text-right text-fg-secondary tabular">{s.misses}</td>
                      <td className="py-1.5 text-right text-fg-secondary tabular">{percent(s.hits, s.hits + s.misses)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {confirmReset && (
        <Dialog
          open
          width="sm"
          onOpenChange={(o) => { if (!o && !resetting) setConfirmReset(false); }}
          title="Reset statistics?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmReset(false)} disabled={resetting}>Cancel</Button>
              <Button variant="danger" onClick={() => { void handleReset(); }} disabled={resetting}>
                {resetting ? "Resetting..." : "Reset"}
              </Button>
            </>
          }
        >
          <p className="text-base text-fg">Are you sure? Every provider's hits and misses go back to zero.</p>
        </Dialog>
      )}
    </>
  );
}
