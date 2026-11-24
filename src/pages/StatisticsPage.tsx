import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { listTorrents } from "../api/torrents";
import { EmptyState, IconButton, Spinner, Toolbar, cn } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { torrentCopies } from "../lib/providers";
import { getCachedTorrents, setCachedTorrents } from "../lib/torrentsCache";
import type { Torrent } from "../types";

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

/** One provider's share of the library. */
export interface ProviderHits {
  provider: string;
  name: string;
  /** Torrents in the library this provider holds a copy of. */
  hits: number;
  /** Of those, how many it has ready to download. */
  ready: number;
}

/** Count, for each provider (in priority order), the library torrents it holds and has ready. */
export function libraryHits(torrents: Torrent[], providers: { id: string; name: string }[]): ProviderHits[] {
  return providers.map(({ id, name }) => {
    let hits = 0;
    let ready = 0;
    for (const t of torrents) {
      const copy = torrentCopies(t).find((c) => c.provider === id);
      if (copy) {
        hits += 1;
        if (copy.status === "downloaded") ready += 1;
      }
    }
    return { provider: id, name, hits, ready };
  });
}

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
  stats: ProviderHits[];
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
            {active.hits} {active.hits === 1 ? "torrent" : "torrents"} · {percent(active.hits, total)}%
          </div>
        </div>
      )}
    </div>
  );
}

const RefreshIcon = ({ spinning }: { spinning: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={spinning ? "animate-spin" : undefined}
  >
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

export default function StatisticsPage() {
  const { accounts } = useAuth();
  const active = useMemo(() => accounts.filter((a) => a.enabled && a.authenticated), [accounts]);
  const activeKey = active.map((a) => a.id).join(",");
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  // Same list (and cache) as the Torrents tab, so opening this page costs no request when the
  // Torrents list is already loaded.
  const [torrents, setTorrents] = useState<Torrent[] | null>(() => getCachedTorrents()?.torrents ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const providers = activeKeyRef.current;
      const data = await listTorrents(1, 500);
      setCachedTorrents(data, providers);
      setTorrents(data);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const cached = getCachedTorrents();
    if (!cached || cached.providers !== activeKey) load();
    else setTorrents(cached.torrents);
  }, [activeKey, load]);

  const stats = useMemo(
    () => (torrents ? libraryHits(torrents, active.map((a) => ({ id: a.id, name: a.name }))) : null),
    [torrents, active],
  );
  const libraryCount = torrents?.length ?? 0;

  return (
    <>
      <Toolbar
        title="Statistics"
        subtitle={torrents ? `${libraryCount} ${libraryCount === 1 ? "torrent" : "torrents"} in the library` : undefined}
        actions={
          <IconButton label="Refresh" onClick={() => { void load(); }} disabled={refreshing}>
            <RefreshIcon spinning={refreshing} />
          </IconButton>
        }
      />
      {error && <div className="border-b border-border px-4 py-2 text-sm text-danger">{error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {stats === null ? (
          !error && <div className="flex justify-center py-24"><Spinner /></div>
        ) : libraryCount === 0 ? (
          <EmptyState title="No torrents yet" hint="Statistics are drawn from the torrents in your library." />
        ) : (
          <section className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            <div>
              <h2 className="text-md font-semibold text-fg">Hits by provider</h2>
              <p className="text-sm text-fg-muted">
                How many of the torrents in your library each enabled provider holds, however they were added.
                A torrent held by several providers counts for each of them.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-8">
              <HitsPie stats={stats} hovered={hovered} onHover={setHovered} />

              <table className="min-w-0 flex-1 text-base" aria-label="Library torrents by provider">
                <thead>
                  <tr className="text-left text-sm text-fg-muted">
                    <th className="pb-2 font-normal">Provider</th>
                    <th className="pb-2 text-right font-normal">Torrents</th>
                    <th className="pb-2 text-right font-normal">Of library</th>
                    <th className="pb-2 text-right font-normal">Ready</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
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
                      <td className="py-1.5 text-right text-fg-secondary tabular">{percent(s.hits, libraryCount)}%</td>
                      <td className="py-1.5 text-right text-fg-secondary tabular">{s.ready}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
