"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "../../../lib/supabase";

type Row = {
  notes: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
};

function stamp(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " at " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

export default function AdminNotesCard({ jobId }: { jobId: string }) {
  const supabase = createClient();

  const [draft, setDraft] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [companyId, setCompanyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedByName, setUpdatedByName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
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

    const { data, error: readError } = await supabase
      .from("job_admin_notes")
      .select("notes, updated_at, updated_by_name")
      .eq("job_id", jobId)
      .maybeSingle();

    if (readError) {
      setError("Couldn't load these notes: " + readError.message);
    }

    const row = (data || null) as unknown as Row | null;
    setDraft(row?.notes ?? "");
    setSavedText(row?.notes ?? "");
    setUpdatedAt(row?.updated_at ?? null);
    setUpdatedByName(row?.updated_by_name ?? null);
    setLoading(false);
  }, [supabase, jobId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!companyId) return;
    setSaving(true);
    setError(null);
    setMessage(null);

    const text = draft.trim();
    const now = new Date().toISOString();

    const { error: saveError } = await supabase.from("job_admin_notes").upsert(
      {
        job_id: jobId,
        company_id: companyId,
        notes: text || null,
        updated_at: now,
        updated_by: userId,
        updated_by_name: userName,
      },
      { onConflict: "job_id" }
    );

    setSaving(false);
    if (saveError) {
      setError("Couldn't save: " + saveError.message);
      return;
    }

    setDraft(text);
    setSavedText(text);
    setUpdatedAt(now);
    setUpdatedByName(userName);
    setMessage("Saved.");
    setTimeout(() => setMessage(null), 2000);
  }

  if (loading) return null;

  const dirty = draft.trim() !== savedText;

  return (
    <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-base font-semibold text-gray-900">Admin notes</h3>
          <span className="px-2 py-0.5 text-xs rounded-full bg-gray-200 text-gray-700">
            Admins only - the floor never sees these
          </span>
        </div>
        {updatedAt && (
          <span className="text-xs text-gray-500">
            Last edited {updatedByName ? "by " + updatedByName + " " : ""}
            {stamp(updatedAt)}
          </span>
        )}
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-red-600 bg-red-50 border-b border-red-200">{error}</div>
      )}

      <div className="p-4">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={5}
          placeholder="Deposits collected, contact details, anything you want on the job but not on the floor..."
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {saving ? "Saving..." : "Save notes"}
          </button>
          {dirty && !saving && <span className="text-xs text-amber-700">Unsaved changes</span>}
          {message && <span className="text-xs text-green-700">{message}</span>}
        </div>
      </div>
    </section>
  );
}
