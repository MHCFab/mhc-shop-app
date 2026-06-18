"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../../lib/supabase";

type Note = {
  id: string;
  note: string;
  is_pinned: boolean;
  created_at: string;
  author_id: string | null;
  author: { full_name: string | null; email: string } | null;
};

export default function NotesTab({ templateId }: { templateId: string }) {
  const supabase = createClient();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("product_template_notes")
      .select("*, author:profiles!product_template_notes_author_id_fkey(full_name, email)")
      .eq("product_template_id", templateId)
      .order("is_pinned", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) setError(error.message);
    else setNotes((data || []) as unknown as Note[]);
    setLoading(false);
  }, [supabase, templateId]);

  useEffect(() => {
    loadCompanyId();
    loadNotes();
  }, [loadCompanyId, loadNotes]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!newNote.trim()) return;
    if (!companyId) {
      setError("Could not determine your company. Try refreshing the page.");
      return;
    }

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("product_template_notes").insert({
      company_id: companyId,
      product_template_id: templateId,
      author_id: user?.id || null,
      note: newNote.trim(),
      is_pinned: false,
    });

    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }

    setNewNote("");
    setSaving(false);
    loadNotes();
  }

  async function handleDelete(note: Note) {
    if (!confirm("Delete this note? This cannot be undone.")) return;
    const { error } = await supabase.from("product_template_notes").delete().eq("id", note.id);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    loadNotes();
  }

  async function togglePin(note: Note) {
    const { error } = await supabase
      .from("product_template_notes")
      .update({ is_pinned: !note.is_pinned })
      .eq("id", note.id);
    if (error) {
      alert("Failed to update: " + error.message);
      return;
    }
    loadNotes();
  }

  function openEdit(note: Note) {
    setEditingId(note.id);
    setEditDraft(note.note);
  }

  async function saveEdit(noteId: string) {
    if (!editDraft.trim()) return;
    const { error } = await supabase
      .from("product_template_notes")
      .update({ note: editDraft.trim() })
      .eq("id", noteId);
    if (error) {
      alert("Failed to save: " + error.message);
      return;
    }
    setEditingId(null);
    setEditDraft("");
    loadNotes();
  }

  function formatDate(iso: string) {
    const d = new Date(iso);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function authorName(note: Note) {
    if (!note.author) return "Unknown";
    return note.author.full_name || note.author.email;
  }

  if (loading) return <p className="text-gray-600">Loading...</p>;

  return (
    <div className="space-y-4">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="text-base font-semibold text-gray-900 mb-1">Build Notes</h3>
        <p className="text-sm text-gray-600 mb-3">
          Tips, gotchas, and lessons learned from building this product. Notes added by employees on the floor also show up here.
        </p>
        <form onSubmit={handleAdd} className="space-y-2">
          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="Add a build note..."
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving || !newNote.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Adding..." : "Add note"}
            </button>
          </div>
        </form>
      </div>

      {notes.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No build notes yet. Add the first one above.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {notes.map((n) => (
            <div
              key={n.id}
              className={
                "bg-white border rounded-lg p-4 " +
                (n.is_pinned ? "border-amber-300 bg-amber-50" : "border-gray-200")
              }
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="text-xs text-gray-500">
                  {n.is_pinned && <span className="inline-block mr-2 px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 font-medium">Pinned</span>}
                  {authorName(n)} &middot; {formatDate(n.created_at)}
                </div>
                <div className="flex gap-3 text-xs whitespace-nowrap">
                  <button onClick={() => togglePin(n)} className="text-gray-600 hover:text-gray-900 font-medium">
                    {n.is_pinned ? "Unpin" : "Pin"}
                  </button>
                  <button onClick={() => openEdit(n)} className="text-blue-600 hover:text-blue-800 font-medium">
                    Edit
                  </button>
                  <button onClick={() => handleDelete(n)} className="text-red-600 hover:text-red-800 font-medium">
                    Delete
                  </button>
                </div>
              </div>

              {editingId === n.id ? (
                <div className="space-y-2">
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => {
                        setEditingId(null);
                        setEditDraft("");
                      }}
                      className="text-sm text-gray-600 hover:text-gray-900 font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => saveEdit(n.id)}
                      className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-900 whitespace-pre-wrap">{n.note}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}