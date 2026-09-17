"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "../../../lib/supabase";

type Item = {
  id: string;
  label: string;
  note: string | null;
  sort_order: number;
  completed_at: string | null;
  completed_by_name: string | null;
};

function shortDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ChecklistCard({ jobId }: { jobId: string }) {
  const supabase = createClient();

  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [defaultsCount, setDefaultsCount] = useState(0);

  const [newLabel, setNewLabel] = useState("");
  const [savingNew, setSavingNew] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data: profile } = await supabase
      .from("profiles")
      .select("company_id, full_name")
      .eq("id", user.id)
      .single();
    if (!profile) {
      setLoading(false);
      return;
    }
    setUserId(user.id);
    setUserName(profile.full_name ?? null);
    setCompanyId(profile.company_id);

    const [itemsRes, defaultsRes] = await Promise.all([
      supabase
        .from("job_checklist_items")
        .select("id, label, note, sort_order, completed_at, completed_by_name")
        .eq("job_id", jobId)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("job_checklist_defaults")
        .select("id")
        .eq("company_id", profile.company_id),
    ]);

    const rows = (itemsRes.data || []) as unknown as Item[];
    setItems(rows);
    setNoteDrafts(Object.fromEntries(rows.map((r) => [r.id, r.note ?? ""])));
    setDefaultsCount((defaultsRes.data || []).length);
    setLoading(false);
  }, [supabase, jobId]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(item: Item) {
    setBusyId(item.id);
    setError(null);
    const isDone = !!item.completed_at;
    const patch = isDone
      ? { completed_at: null, completed_by: null, completed_by_name: null }
      : { completed_at: new Date().toISOString(), completed_by: userId, completed_by_name: userName };

    const { error: updateError } = await supabase
      .from("job_checklist_items")
      .update(patch)
      .eq("id", item.id);
    setBusyId(null);
    if (updateError) {
      setError("Couldn't save that: " + updateError.message);
      return;
    }
    setItems((prev) =>
      prev.map((i) =>
        i.id === item.id
          ? { ...i, completed_at: patch.completed_at, completed_by_name: patch.completed_by_name }
          : i
      )
    );
  }

  async function saveNote(item: Item) {
    const draft = (noteDrafts[item.id] ?? "").trim();
    if (draft === (item.note ?? "")) return;
    setError(null);
    const { error: updateError } = await supabase
      .from("job_checklist_items")
      .update({ note: draft || null })
      .eq("id", item.id);
    if (updateError) {
      setError("Couldn't save that note: " + updateError.message);
      return;
    }
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, note: draft || null } : i)));
  }

  async function addItem() {
    const label = newLabel.trim();
    if (!label || !companyId) return;
    setSavingNew(true);
    setError(null);
    const nextOrder = items.reduce((max, i) => Math.max(max, i.sort_order), 0) + 1;
    const { error: insertError } = await supabase
      .from("job_checklist_items")
      .insert({ company_id: companyId, job_id: jobId, label, sort_order: nextOrder });
    setSavingNew(false);
    if (insertError) {
      setError("Couldn't add that: " + insertError.message);
      return;
    }
    setNewLabel("");
    await load();
  }

  async function removeItem(item: Item) {
    if (!confirm('Remove "' + item.label + '" from this job\'s checklist?')) return;
    setBusyId(item.id);
    setError(null);
    const { error: deleteError } = await supabase
      .from("job_checklist_items")
      .delete()
      .eq("id", item.id);
    setBusyId(null);
    if (deleteError) {
      setError("Couldn't remove that: " + deleteError.message);
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }

  async function addDefaults() {
    if (!companyId) return;
    setSeeding(true);
    setError(null);
    const { data: defaults, error: readError } = await supabase
      .from("job_checklist_defaults")
      .select("label, sort_order")
      .eq("company_id", companyId)
      .order("sort_order", { ascending: true });
    if (readError) {
      setSeeding(false);
      setError("Couldn't read your default list: " + readError.message);
      return;
    }
    const rows = (defaults || []) as unknown as { label: string; sort_order: number }[];
    if (rows.length === 0) {
      setSeeding(false);
      return;
    }
    const base = items.reduce((max, i) => Math.max(max, i.sort_order), 0);
    const { error: insertError } = await supabase.from("job_checklist_items").insert(
      rows.map((r, idx) => ({
        company_id: companyId,
        job_id: jobId,
        label: r.label,
        sort_order: base + idx + 1,
      }))
    );
    setSeeding(false);
    if (insertError) {
      setError("Couldn't add the default list: " + insertError.message);
      return;
    }
    await load();
  }

  if (loading) return null;

  const doneCount = items.filter((i) => i.completed_at).length;
  const allDone = items.length > 0 && doneCount === items.length;
  const percent = items.length === 0 ? 0 : Math.round((doneCount / items.length) * 100);

  return (
    <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-gray-900">My checklist</h3>
          <span className="text-xs text-gray-500">(admins only)</span>
        </div>
        {items.length > 0 && (
          <div className="flex items-center gap-3">
            <div className="w-28 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={"h-full rounded-full " + (allDone ? "bg-green-600" : "bg-blue-600")}
                style={{ width: percent + "%" }}
              />
            </div>
            <span className={"text-sm font-medium " + (allDone ? "text-green-700" : "text-gray-700")}>
              {doneCount} of {items.length} done
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-red-600 bg-red-50 border-b border-red-200">{error}</div>
      )}

      {items.length === 0 ? (
        <div className="px-4 py-5 text-sm text-gray-600">
          {defaultsCount > 0 ? (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span>This job was created before you set up a checklist.</span>
              <button
                onClick={addDefaults}
                disabled={seeding}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {seeding ? "Adding..." : "Add my default list"}
              </button>
            </div>
          ) : (
            <p>
              Nothing here yet. Set up the list you want on every job under Settings, or add a
              one-off item below.
            </p>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {items.map((item) => {
            const done = !!item.completed_at;
            return (
              <li key={item.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={done}
                    disabled={busyId === item.id}
                    onChange={() => toggle(item)}
                    className="mt-1 h-4 w-4 rounded border-gray-300 cursor-pointer"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span
                        className={
                          "text-sm font-medium " + (done ? "text-gray-400 line-through" : "text-gray-900")
                        }
                      >
                        {item.label}
                      </span>
                      {done && item.completed_at && (
                        <span className="text-xs text-green-700">
                          {item.completed_by_name ? item.completed_by_name + " · " : ""}
                          {shortDate(item.completed_at)}
                        </span>
                      )}
                    </div>
                    <input
                      type="text"
                      value={noteDrafts[item.id] ?? ""}
                      onChange={(e) =>
                        setNoteDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))
                      }
                      onBlur={() => saveNote(item)}
                      placeholder="Note (PO number, vendor, lead time...)"
                      className="mt-1 w-full px-2 py-1 text-xs text-gray-700 bg-transparent border border-transparent rounded hover:border-gray-200 focus:bg-white focus:border-blue-400 focus:outline-none"
                    />
                  </div>
                  <button
                    onClick={() => removeItem(item)}
                    disabled={busyId === item.id}
                    title="Remove from this job"
                    className="text-gray-300 hover:text-red-600 text-lg leading-none px-1 disabled:opacity-50"
                  >
                    &times;
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 flex items-center gap-2">
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
          placeholder="Add an item just for this job..."
          className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={addItem}
          disabled={savingNew || !newLabel.trim()}
          className="px-3 py-1.5 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:opacity-40 transition-colors"
        >
          {savingNew ? "Adding..." : "Add"}
        </button>
      </div>
    </section>
  );
}
