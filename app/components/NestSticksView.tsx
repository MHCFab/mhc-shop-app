/**
 * NestSticksView - the read-only picture of a cutting nest.
 *
 * ONE renderer for the stick diagrams and per-stick cut lists, shared by the
 * admin Cutting Nest optimizer and the floor Cut Nest tab. If the drawing ever
 * needs to change, it changes here and both screens follow. Do not re-inline
 * this in a page.
 *
 * It renders a plan; it never loads, edits or applies one. Everything it needs
 * comes in through props.
 */

import { formatLength, type NestStick } from "../lib/nest-optimizer";

/** Inches, no feet - cut lists read in inches on the shop floor. */
function inches(v: number) {
  return formatLength(v, { useFeet: false });
}

/**
 * Turn a miter offset back into the angle a man reads off the saw.
 * s = H * tan(t) * dir, so t = atan(|s| / H); a positive offset leans "/".
 */
function angleText(s: number, height: number): string {
  if (!height || !s) return "";
  const deg = (Math.atan(Math.abs(s) / height) * 180) / Math.PI;
  if (deg < 0.05) return "";
  return (deg < 10 ? deg.toFixed(1) : deg.toFixed(0)) + "° " + (s > 0 ? "/" : "\\");
}

export default function NestSticksView({
  sticks,
  fallbackDepth = 1,
  showAngles = false,
  large = false,
}: {
  sticks: NestStick[];
  /** Used for the drawing's vertical scale when a stick carries no depth. */
  fallbackDepth?: number;
  /** Spell out each mitered end in degrees - what the floor needs at the saw. */
  showAngles?: boolean;
  /** Bigger type and a taller bar, for a phone in the shop. */
  large?: boolean;
}) {
  return (
    <div className="divide-y divide-gray-100">
      {sticks.map((st, i) => {
        // The polygons were built against the stick's own depth, so that is
        // what the viewBox has to be or the lean comes out wrong. Fall back
        // only when the plan was made with no depth recorded.
        const vbDepth = st.height > 0 ? st.height : fallbackDepth > 0 ? fallbackDepth : 1;
        return (
          <div key={i} className={large ? "p-4" : "p-3"}>
            <div className="flex items-baseline gap-3 flex-wrap mb-2">
              <span className={(large ? "text-base " : "text-sm ") + "font-semibold text-gray-900"}>
                Stick {i + 1}
              </span>
              <span className={(large ? "text-base " : "text-sm ") + "text-gray-600 font-mono"}>
                {inches(st.stockLength)}
              </span>
              <span className="ml-auto text-xs font-mono text-gray-500">
                used {inches(st.consumed)} &middot; drop {inches(st.drop)}{" "}
                {st.usableDrop ? (
                  <span className="text-green-700">back on the rack</span>
                ) : (
                  <span className="text-amber-700">scrap</span>
                )}
              </span>
            </div>

            {/* One bar per stick. Each piece is drawn as the four-sided shape
                it really is: the bottom face runs pBottom -> qBottom, and the
                top face is shifted by the miter offset at each end. So a
                mitered end leans, and two ends cut in one blade pass share an
                edge instead of sitting square against each other. */}
            <div
              className={
                (large ? "h-16 " : "h-12 ") +
                "relative w-full bg-gray-100 border border-gray-300 rounded-sm overflow-hidden"
              }
            >
              <svg
                viewBox={"0 0 " + st.stockLength + " " + vbDepth}
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full"
                aria-hidden="true"
              >
                {st.pieces.map((p, j) => (
                  <polygon
                    key={j}
                    points={
                      (p.pBottom + p.sLead) + ",0 " +
                      (p.qBottom + p.sTrail) + ",0 " +
                      p.qBottom + "," + vbDepth + " " +
                      p.pBottom + "," + vbDepth
                    }
                    fill={p.sharedCut ? "#a5c8fb" : "#bfdbfe"}
                    stroke="#2563eb"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>
              {st.pieces.map((p, j) => (
                <span
                  key={j}
                  title={p.label + " " + inches(p.length) + (p.sharedCut ? " — shares the previous cut" : "")}
                  className={
                    (large ? "text-xs " : "text-[10px] ") +
                    "pointer-events-none absolute top-1/2 -translate-y-1/2 truncate px-0.5 text-center font-medium text-blue-900"
                  }
                  style={{
                    left: (p.startX / st.stockLength) * 100 + "%",
                    width: ((p.endX - p.startX) / st.stockLength) * 100 + "%",
                  }}
                >
                  {p.label}
                </span>
              ))}
            </div>

            <table className={(large ? "text-base " : "text-sm ") + "w-full mt-2"}>
              <tbody>
                {st.pieces.map((p, j) => {
                  const lead = showAngles ? angleText(p.sLead, st.height) : "";
                  const trail = showAngles ? angleText(p.sTrail, st.height) : "";
                  return (
                    <tr key={j} className="border-t border-gray-100 first:border-t-0">
                      {large && <td className="py-1.5 pr-2 font-mono text-gray-400 w-6">{j + 1}</td>}
                      <td className={(large ? "py-1.5 " : "py-1 ") + "text-gray-900"}>{p.label}</td>
                      <td className={(large ? "py-1.5 " : "py-1 ") + "font-mono text-gray-700"}>
                        {inches(p.length)}
                      </td>
                      <td className={(large ? "py-1.5 " : "py-1 ") + "text-xs text-gray-500"}>
                        {showAngles && (lead || trail) ? (
                          <span className="font-mono text-gray-700">
                            {lead || "square"} &middot; {trail || "square"}
                          </span>
                        ) : p.sLead || p.sTrail ? (
                          "mitered"
                        ) : (
                          "square"
                        )}
                        {p.sharedCut ? " · shares the previous cut" : ""}
                        {p.flipped ? " · turned" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
