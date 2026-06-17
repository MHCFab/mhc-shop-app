"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "../../../lib/supabase";

type Template = {
  id: string;
  name: string;
  product_number: string | null;
  description: string | null;
};

type Photo = {
  id: string;
  storage_path: string;
  caption: string | null;
  url: string;
};

type Note = {
  id: string;
  note: string;
  is_pinned: boolean;
  created_at: string;
  author: { full_name: string | null; email: string } | null;
};

export default function FloorProductDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const supabase = createClient();

  const [template, setTemplate] = useState<Template | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);

  const [newNote, setNewNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [tplRes, photoRes, noteRes] = await Promise.all([
      supabase.from("product_templates").select("id, name, product_number, description").eq("id", id).single(),
      supabase.from("product_template_photos").select("id, storage_path, caption").eq("product_template_id", id).order("sort_order"),
      supabase
        .from("product_template_notes")
        .select("id, note, is_pinned, created_at, author:profiles!product_template_notes_author_id_fkey(full_name, email)")
        .eq("product_template_id", id)
        .order("is_pinned", { ascending: false })
        .order("created_at", { ascending: false }),
    ]);

    if (tplRes.error) {
      setError(tplRes.error.message);
      setLoading(false);
      return;
    }
    setTemplate(tplRes.data as Template);

    const photosWithUrls: Photo[] = await Promise.all(
      (photoRes.data || []).map(async (p) => {
        const { data: signed } = await supabase.storage.from("product-photos").createSignedUrl(p.storage_path, 60 * 60);
        return { ...p, url: signed?.signedUrl || "" };
      })
    );
    setPhotos(photosWithUrls);
    setNotes((noteRes.data || []) as Note[]);
    setLoading(false);
  }, [supabase, id]);

  useEffect(() => {
    loadCompanyId();
    loadData();
  }, [loadCompanyId, loadData]);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!newNote.trim() || !companyId) return;
    setSavingNote(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("product_template_notes").insert({
      company_id: companyId,
      product_template_id: id,
      author_id: user?.id || null,
      note: newNote.trim(),
      is_pinned: false,
    });
    setSavingNote(false);
    if (error) {
      alert("Failed to add note: " + error.message);
      return;
    }
    setNewNote("");
    loadData();
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0 || !companyId) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        if (file.size > 10 * 1024 * 1024) {
          alert("File too large (max 10MB): " + file.name);
          continue;
        }
        const ext = file.name.split(".").pop() || "jpg";
        const path = companyId + "/" + id + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
        const { error: upErr } = await supabase.storage.from("product-photos").upload(path, file, { cacheControl: "3600", upsert: false });
        if (upErr) {
          alert("Upload failed: " + upErr.message);
          continue;
        }
        await supabase.from("product_template_photos").insert({
          company_id: companyId,
          product_template_id: id,
          storage_path: path,
          caption: null,
          sort_order: photos.length,
        });
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadData();
    } finally {
      setUploading(false);
    }
  }

  function formatDate(iso: string) {
    const d = new Date(iso);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function authorName(n: Note) {
    if (!n.author) return "Unknown";
    return n.author.full_name || n.author.email;
  }

  if (loading) return <p className="text-gray-600">Loading...</p>;

  if (error || !template) {
    return (
      <div>
        <Link href="/floor" className="text-sm text-blue-600 hover:text-blue-800 mb-3 inline-block">&larr; Back to board</Link>
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700">{error || "Product not found."}</div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={() => history.back()} className="text-sm text-blue-600 hover:text-blue-800 mb-3 inline-block">&larr; Back</button>

      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <h1 className="text-2xl font-bold text-gray-900">{template.name}</h1>
        {template.product_number && <p className="text-gray-500 mt-1">{template.product_number}</p>}
        {template.description && <p className="text-gray-700 mt-2">{template.description}</p>}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden mb-4">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <span className="font-semibold text-gray-900">Photos</span>
          <label className="text-sm text-blue-600 hover:text-blue-800 font-medium cursor-pointer">
            {uploading ? "Uploading..." : "Add photo"}
            <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleUpload} disabled={uploading} className="hidden" />
          </label>
        </div>
        {photos.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-600 text-center">No photos yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 p-3">
            {photos.map((p) => (
              <div key={p.id} className="rounded-lg overflow-hidden border border-gray-200">
                <div className="relative w-full h-40 bg-gray-100">
                  {p.url && <Image src={p.url} alt={p.caption || "Product photo"} fill sizes="50vw" className="object-cover" unoptimized />}
                </div>
                {p.caption && <p className="text-xs text-gray-700 p-2">{p.caption}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 font-semibold text-gray-900">Build Notes</div>
        <div className="p-4">
          <form onSubmit={addNote} className="mb-4">
            <textarea
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="Add a build note, tip, or gotcha..."
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex justify-end mt-2">
              <button type="submit" disabled={savingNote || !newNote.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium text-sm hover:bg-blue-700 disabled:opacity-50">
                {savingNote ? "Adding..." : "Add note"}
              </button>
            </div>
          </form>

          {notes.length === 0 ? (
            <p className="text-sm text-gray-600 text-center py-2">No build notes yet. Add the first one.</p>
          ) : (
            <div className="space-y-3">
              {notes.map((n) => (
                <div key={n.id} className={"border rounded-lg p-3 " + (n.is_pinned ? "border-amber-300 bg-amber-50" : "border-gray-200")}>
                  <div className="text-xs text-gray-500 mb-1">
                    {n.is_pinned && <span className="inline-block mr-2 px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 font-medium">Pinned</span>}
                    {authorName(n)} &middot; {formatDate(n.created_at)}
                  </div>
                  <p className="text-sm text-gray-900 whitespace-pre-wrap">{n.note}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}