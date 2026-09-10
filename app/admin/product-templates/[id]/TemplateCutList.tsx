"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "../../../lib/supabase";
import { parseLength, formatLength, type MiterDir } from "../../../lib/nest-optimizer";

/**
 * The cut list for ONE material line of a product template: the actual pieces
 * that come off the saw for one finished unit.
 *
 * Two things worth knowing about how this behaves:
 *
 *  - Lengths are LONG POINT, in inches, the way a cut is called out on a shop
 *    drawing. They are typed the way the shop writes them - 76 1/2, 8'-6 1/2" -
 *    and stored as a decimal.
 *
 *  - Saving ANY piece here makes the database recalculate the material's feet
 *    per unit from the pieces. That is why every write calls onChanged(): the
 *    number on the BOM row above is now stale until it reloads.
 */

type CutItem = {
  id: string;
  mark: string | null;
  length_inches: number;
  quantity_per_unit: number;
  lead_angle: number;
  lead_dir: number;
  trail_angle: number;
  trail_dir: number;
  allow_flip: boolean;
  notes: string | null;
  sort_order: number;
};

type Draft = {
  mark: string;
  length: string;
  quantity: string;
  leadAngle: string;
  leadDir: MiterDir;
  trailAngle: string;
  trailDir: MiterDir;
  allowFlip: boolean;
};

const BLANK: Draft = {
  mark: "",
  length: "",
  quantity: "1",
  leadAngle: "0",
  leadDir: 1,
  trailAngle: "0",
  trailDir: 1,
  allowFlip: true,
};

function toDraft(c: CutItem): Draft {
  return {
    mark: c.mark || "",
    length: formatLength(Number(c.length_inches), { useFeet: false }),
    quantity: String(c.quantity_per_unit),
    leadAngle: String(Number(c.lead_angle)),
    leadDir: (Number(c.lead_dir) === -1 ? -1 : 1) as MiterDir,
    trailAngle: String(Number(c.trail_angle)),
    trailDir: (Number(c.trail_dir) === -1 ? -1 : 1) as MiterDir,
    allowFlip: c.allow_flip !== false,
  };
}

type CutItemWrite = {
  mark: string | null;
  length_inches: number;
  quantity_per_unit: number;
  lead_angle: number;
  lead_dir: MiterDir;
  trail_angle: number;
  trail_dir: MiterDir;
  allow_flip: boolean;
};

/**
 * Shared by the add form and the edit form, so they can never drift apart.
 * Discriminated on `ok` rather than on the presence of `error`, so the caller
 * gets a properly narrowed row instead of "row might be undefined".
 */
type ParsedPiece = { ok: false; error: string } | { ok: true; row: CutItemWrite };

function draftToRow(d: Draft): ParsedPiece {
  const len = parseLength(d.length);
  if (len === null || len <= 0) {
    return { ok: false, error: "Give the piece a length - 76 1/2, or 8'-6 1/2\"." };
  }
  const qty = parseInt(d.quantity, 10);
  if (isNaN(qty) || qty < 1) {
    return { ok: false, error: "How many of this piece in one unit? Whole pieces only." };
  }
  const lead = Math.abs(parseFloat(d.leadAngle) || 0);
  const trail = Math.abs(parseFloat(d.trailAngle) || 0);
  if (lead >= 90 || trail >= 90) {
    return { ok: false, error: "An end angle has to be less than 90 degrees off square." };
  }
  return {
    ok: true,
    row: {
      mark: d.mark.trim() || null,
      length_inches: len,
      quantity_per_unit: qty,
      lead_angle: lead,
      lead_dir: d.leadDir,
      trail_angle: trail,
      trail_dir: d.trailDir,
      allow_flip: d.allowFlip,
    },
  };
}

function angleLabel(angle: number, dir: number) {
  const a = Number(angle);
  if (!a) return "Square";
  return a + "° " + (Number(dir) === -1 ? "\\" : "/");
}

export default function TemplateCutList({
  materialRowId,
  companyId,
  materialLabel,
  onChanged,
}: {
  /** product_template_materials.id - the BOM line these pieces are cut from. */
  materialRowId: string;
  companyId: string;
  materialLabel: string;
  /** Called after any write, because feet per unit has just been recalculated. */
  onChanged: () => void;
}) {
  const supabase = createClient();

  const [items, setItems] = useState<CutItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<Draft>(BLANK);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(BLANK);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: loadErr } = await supabase
      .from("product_template_cut_items")
      .select("*")
      .eq("product_template_material_id", materialRowId)
      .order("sort_order");
    if (loadErr) setError(loadErr.message);
    setItems((data || []) as unknown as CutItem[]);
    setLoading(false);
  }, [supabase, materialRowId]);

  useEffect(() => {
    load();
  }, [load]);

  const totalInches = items.reduce(
    (sum, c) => sum + Number(c.length_inches) * Number(c.quantity_per_unit),
    0
  );

  async function addPiece() {
    const parsed = draftToRow(addDraft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: insErr } = await supabase.from("product_template_cut_items").insert({
      company_id: companyId,
      product_template_material_id: materialRowId,
      ...parsed.row,
      sort_order: items.length,
    });
    setBusy(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    setAddDraft(BLANK);
    setAdding(false);
    await load();
    onChanged();
  }

  async function savePiece(id: string) {
    const parsed = draftToRow(editDraft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: updErr } = await supabase
      .from("product_template_cut_items")
      .update(parsed.row)
      .eq("id", id);
    setBusy(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    setEditingId(null);
    await load();
    onChanged();
  }

  async function removePiece(id: string) {
    setBusy(true);
    setError(null);
    const { error: delErr } = await supabase
      .from("product_template_cut_items")
      .delete()
      .eq("id", id);
    setBusy(false);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    await load();
    onChanged();
  }

  function angleFields(d: Draft, set: (patch: Partial<Draft>) => void, which: "lead" | "trail") {
    const angle = which === "lead" ? d.leadAngle : d.trailAngle;
    const dir = which === "lead" ? d.leadDir : d.trailDir;
    return (
      <div className="flex items-center gap-1">
        <input
          type="number"
          step="0.5"
          min="0"
          max="89"
          value={angle}
          onChange={(e) =>
            set(which === "lead" ? { leadAngle: e.target.value } : { trailAngle: e.target.value })
          }
          className="w-16 px-2 py-1 border border-gray-300 rounded text-right text-gray-900"
        />
        <select
          value={String(dir)}
          onChange={(e) => {
            const v = (Number(e.target.value) === -1 ? -1 : 1) as MiterDir;
            set(which === "lead" ? { leadDir: v } : { trailDir: v });
          }}
          className="px-2 py-1 border border-gray-300 rounded text-gray-900"
        >
          <option value="1">/</option>
          <option value="-1">\</option>
        </select>
      </div>
    );
  }

  const headerCells = ["Mark", "Length", "Qty / unit", "Lead end", "Trail end", "Flip", ""];

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-md p-3 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-gray-900">Cut list &mdash; {materialLabel}</div>
          <p className="text-xs text-gray-600 mt-1">
            The pieces that come off the saw for ONE finished unit. Lengths are long point, in
            inches. While this list has anything in it, feet per unit is added up from these
            pieces instead of being typed.
          </p>
        </div>
        {!adding && (
          <button
            onClick={() => {
              setAdding(true);
              setAddDraft(BLANK);
              setError(null);
            }}
            disabled={busy}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50 shrink-0"
          >
            + Add piece
          </button>
        )}
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-600">Loading&hellip;</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                {headerCells.map((h, i) => (
                  <th key={i} className={"py-2 pr-3 font-medium" + (i === 6 ? " text-right" : "")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const isEditing = editingId === c.id;
                const set = (patch: Partial<Draft>) => setEditDraft((prev) => ({ ...prev, ...patch }));
                if (isEditing) {
                  return (
                    <tr key={c.id} className="border-t border-gray-200">
                      <td className="py-2 pr-3">
                        <input
                          type="text"
                          value={editDraft.mark}
                          onChange={(e) => set({ mark: e.target.value })}
                          className="w-24 px-2 py-1 border border-gray-300 rounded text-gray-900"
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <input
                          type="text"
                          value={editDraft.length}
                          onChange={(e) => set({ length: e.target.value })}
                          className="w-28 px-2 py-1 border border-gray-300 rounded text-right font-mono text-gray-900"
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={editDraft.quantity}
                          onChange={(e) => set({ quantity: e.target.value })}
                          className="w-20 px-2 py-1 border border-gray-300 rounded text-right text-gray-900"
                        />
                      </td>
                      <td className="py-2 pr-3">{angleFields(editDraft, set, "lead")}</td>
                      <td className="py-2 pr-3">{angleFields(editDraft, set, "trail")}</td>
                      <td className="py-2 pr-3">
                        <input
                          type="checkbox"
                          checked={editDraft.allowFlip}
                          onChange={(e) => set({ allowFlip: e.target.checked })}
                          className="w-4 h-4"
                        />
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => savePiece(c.id)}
                          disabled={busy}
                          className="text-blue-600 hover:text-blue-800 font-medium mr-3 disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          disabled={busy}
                          className="text-gray-600 hover:text-gray-900 font-medium disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={c.id} className="border-t border-gray-200">
                    <td className="py-2 pr-3 text-gray-900">{c.mark || "-"}</td>
                    <td className="py-2 pr-3 text-gray-900 font-mono">
                      {formatLength(Number(c.length_inches), { useFeet: false })}
                    </td>
                    <td className="py-2 pr-3 text-gray-700">{c.quantity_per_unit}</td>
                    <td className="py-2 pr-3 text-gray-700 font-mono">
                      {angleLabel(c.lead_angle, c.lead_dir)}
                    </td>
                    <td className="py-2 pr-3 text-gray-700 font-mono">
                      {angleLabel(c.trail_angle, c.trail_dir)}
                    </td>
                    <td className="py-2 pr-3 text-gray-700">{c.allow_flip !== false ? "Yes" : "No"}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => {
                          setEditingId(c.id);
                          setEditDraft(toDraft(c));
                          setError(null);
                        }}
                        disabled={busy}
                        className="text-blue-600 hover:text-blue-800 font-medium mr-3 disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => removePiece(c.id)}
                        disabled={busy}
                        className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}

              {adding && (
                <tr className="border-t border-gray-200 bg-white">
                  <td className="py-2 pr-3">
                    <input
                      type="text"
                      placeholder="RAIL-A"
                      value={addDraft.mark}
                      onChange={(e) => setAddDraft({ ...addDraft, mark: e.target.value })}
                      className="w-24 px-2 py-1 border border-gray-300 rounded text-gray-900"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      type="text"
                      placeholder="76 1/2"
                      value={addDraft.length}
                      onChange={(e) => setAddDraft({ ...addDraft, length: e.target.value })}
                      className="w-28 px-2 py-1 border border-gray-300 rounded text-right font-mono text-gray-900"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={addDraft.quantity}
                      onChange={(e) => setAddDraft({ ...addDraft, quantity: e.target.value })}
                      className="w-20 px-2 py-1 border border-gray-300 rounded text-right text-gray-900"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    {angleFields(addDraft, (patch) => setAddDraft({ ...addDraft, ...patch }), "lead")}
                  </td>
                  <td className="py-2 pr-3">
                    {angleFields(addDraft, (patch) => setAddDraft({ ...addDraft, ...patch }), "trail")}
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      type="checkbox"
                      checked={addDraft.allowFlip}
                      onChange={(e) => setAddDraft({ ...addDraft, allowFlip: e.target.checked })}
                      className="w-4 h-4"
                    />
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button
                      onClick={addPiece}
                      disabled={busy}
                      className="text-blue-600 hover:text-blue-800 font-medium mr-3 disabled:opacity-50"
                    >
                      Add
                    </button>
                    <button
                      onClick={() => {
                        setAdding(false);
                        setError(null);
                      }}
                      disabled={busy}
                      className="text-gray-600 hover:text-gray-900 font-medium disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              )}

              {items.length === 0 && !adding && (
                <tr className="border-t border-gray-200">
                  <td colSpan={7} className="py-4 text-sm text-gray-600">
                    No pieces yet. Feet per unit for this material is whatever you typed on the
                    row above, exactly as before.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {items.length > 0 && (
        <div className="text-xs text-gray-600 border-t border-gray-200 pt-2">
          {items.reduce((n, c) => n + Number(c.quantity_per_unit), 0)} pieces,{" "}
          <span className="font-mono">{formatLength(totalInches, { useFeet: false })}</span> total
          &mdash; <span className="font-mono">{(totalInches / 12).toFixed(4)} ft</span> per unit.
          This is exact cut footage: no kerf, no drop, no waste.
        </div>
      )}
    </div>
  );
}
