"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "../../lib/supabase";

type DefaultItem = {
  id: string;
  label: string;
  sort_order: number;
};

export default function ChecklistDefaults({ companyId }: { companyId: string | null }) {
  const supabase = createClient();

  const [items, setItems] = useState<DefaultItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error: readError } = await supabase
      .from("job_checklist_defaults")
      .select("id, label, sort_order")
      .eq("company_id", companyId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (readError) {
      setError("Couldn't load your checklist: " + readError.message);
      setLoading(false);
      return;
    }
    const rows = (data || []) as unknown as DefaultItem[];
    setItems(rows);
    setDrafts(Object.fromEntries(rows.map((r) => [r.id, r.label])));
    setLoading(false);
  }, [supabase, companyId]);

  useEffect(() => {
    load();
  }, [load]);

  async function addItem() {
    const label = newLabel.trim();
    if (!label || !companyId) return;
    setBusy(true);
    setError(null);
    const nextOrder = items.reduce((max, i) => Math.max(max, i.sort_order), 0) + 1;
    const { error: insertError } = await supabase
      .from("job_checklist_defaults")
      .insert({ company_id: companyId, label, sort_order: nextOrder });
    setBusy(false);
    if (insertError) {
      setError("Couldn't add that: " + insertError.message);
      return;
    }
    setNewLabel("");
    await load();
  }

  async function renameItem(item: DefaultItem) {
    const label = (drafts[item.id] ?? "").trim();
    if (!label || label === item.label) {
      setDrafts((prev) => ({ ...prev, [item.id]: item.label }));
      return;
    }
    setError(null);
    const { error: updateError } = await supabase
      .from("job_checklist_defaults")
      .update({ label })
      .eq("id", item.id);
    if (updateError) {
      setError("Couldn't rename that: " + updateError.message);
      setDrafts((prev) => ({ ...prev, [item.id]: item.label }));
      return;
    }
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, label } : i)));
  }

  async function removeItem(item: DefaultItem) {
    if (!confirm('Remove "' + item.label + '" from your default checklist?\n\nJobs that already have it keep it.')) return;
    setBusy(true);
    setError(null);
    const { error: deleteError } = await supabase
      .from("job_checklist_defaults")
      .delete()
      .eq("id", item.id);
    setBusy(false);
    if (deleteError) {
      setError("Couldn't remove that: " + deleteError.message);
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const a = items[index];
    const b = items[target];
    setBusy(true);
    setError(null);
    const [resA, resB] = await Promise.all([
      supabase.from("job_checklist_defaults").update({ sort_order: b.sort_order }).eq("id", a.id),
      supabase.from("job_checklist_defaults").update({ sort_order: a.sort_order }).eq("id", b.id),
    ]);
    setBusy(false);
    if (resA.error || resB.error) {
      setError("Couldn't reorder: " + (resA.error?.message || resB.error?.message));
      await load();
      return;
    }
    const next = items.slice();
    next[index] = { ...b, sort_order: a.sort_order };
    next[target] = { ...a, sort_order: b.sort_order };
    setItems(next);
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 mt-6">
      <h2 className="text-base font-semibold text-gray-900 mb-1">My job checklist</h2>
      <p className="text-xs text-gray-500 mb-4">
        Your own to-do list for a job &mdash; design parts, order material, and so on. Every new
        job starts with this list, and you tick it off on the job&apos;s Overview tab. Only admins
        see it; the floor never does. Changing it here does not change jobs that already exist.
      </p>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-3">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-600">Loading...</p>
      ) : (
        <>
          {items.length === 0 ? (
            <p className="text-sm text-gray-600 mb-3">
              No items yet. Add your first one below.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md mb-3">
              {items.map((item, index) => (
                <li key={item.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={busy || index === 0}
                      title="Move up"
                      className="text-gray-400 hover:text-gray-700 disabled:opacity-25 text-xs leading-none"
                    >
                      &#9650;
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={busy || index === items.length - 1}
                      title="Move down"
                      className="text-gray-400 hover:text-gray-700 disabled:opacity-25 text-xs leading-none"
                    >
                      &#9660;
                    </button>
                  </div>
                  <input
                    type="text"
                    value={drafts[item.id] ?? ""}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    onBlur={() => renameItem(item)}
                    className="flex-1 px-2 py-1 text-sm text-gray-900 bg-transparent border border-transparent rounded hover:border-gray-200 focus:bg-white focus:border-blue-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(item)}
                    disabled={busy}
                    title="Remove"
                    className="text-gray-300 hover:text-red-600 text-lg leading-none px-1 disabled:opacity-50"
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addItem();
                }
              }}
              placeholder="e.g. Order material"
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={addItem}
              disabled={busy || !newLabel.trim()}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              Add
            </button>
          </div>
        </>
      )}
    </div>
  );
}
