"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Image from "next/image";
import { createClient } from "../../../lib/supabase";

type Photo = {
  id: string;
  storage_path: string;
  caption: string | null;
  sort_order: number;
  created_at: string;
};

type PhotoWithUrl = Photo & { url: string };

export default function PhotosTab({ templateId }: { templateId: string }) {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [photos, setPhotos] = useState<PhotoWithUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingCaptionId, setEditingCaptionId] = useState<string | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");

  const loadCompanyId = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }, [supabase]);

  const loadPhotos = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("product_template_photos")
      .select("*")
      .eq("product_template_id", templateId)
      .order("sort_order");

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    const photosWithUrls: PhotoWithUrl[] = await Promise.all(
      (data || []).map(async (p) => {
        const { data: signed } = await supabase.storage
          .from("product-photos")
          .createSignedUrl(p.storage_path, 60 * 60);
        return { ...p, url: signed?.signedUrl || "" };
      })
    );

    setPhotos(photosWithUrls);
    setLoading(false);
  }, [supabase, templateId]);

  useEffect(() => {
    loadCompanyId();
    loadPhotos();
  }, [loadCompanyId, loadPhotos]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (!companyId) {
      setError("Could not determine your company. Try refreshing the page.");
      return;
    }

    setUploading(true);
    setError(null);

    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) {
          setError("Only image files can be uploaded. Skipped: " + file.name);
          continue;
        }
        if (file.size > 10 * 1024 * 1024) {
          setError("File too large (max 10MB). Skipped: " + file.name);
          continue;
        }

        const ext = file.name.split(".").pop() || "jpg";
        const path = companyId + "/" + templateId + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;

        const { error: uploadError } = await supabase.storage
          .from("product-photos")
          .upload(path, file, { cacheControl: "3600", upsert: false });

        if (uploadError) {
          setError("Upload failed: " + uploadError.message);
          continue;
        }

        const { error: insertError } = await supabase.from("product_template_photos").insert({
          company_id: companyId,
          product_template_id: templateId,
          storage_path: path,
          caption: null,
          sort_order: photos.length,
        });

        if (insertError) {
          setError("Failed to save photo record: " + insertError.message);
        }
      }

      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadPhotos();
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(photo: PhotoWithUrl) {
    if (!confirm("Delete this photo? This cannot be undone.")) return;

    const { error: storageError } = await supabase.storage
      .from("product-photos")
      .remove([photo.storage_path]);

    if (storageError) {
      alert("Failed to delete photo file: " + storageError.message);
      return;
    }

    const { error: dbError } = await supabase
      .from("product_template_photos")
      .delete()
      .eq("id", photo.id);

    if (dbError) {
      alert("Failed to delete photo record: " + dbError.message);
      return;
    }

    loadPhotos();
  }

  function openCaptionEdit(photo: PhotoWithUrl) {
    setEditingCaptionId(photo.id);
    setCaptionDraft(photo.caption || "");
  }

  async function saveCaption(photoId: string) {
    const { error } = await supabase
      .from("product_template_photos")
      .update({ caption: captionDraft.trim() || null })
      .eq("id", photoId);

    if (error) {
      alert("Failed to save caption: " + error.message);
      return;
    }
    setEditingCaptionId(null);
    setCaptionDraft("");
    loadPhotos();
  }

  if (loading) return <p className="text-gray-600">Loading...</p>;

  return (
    <div className="space-y-4">
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Photos</h3>
            <p className="text-sm text-gray-600 mt-1">Reference images, finished product, problem areas, anything that helps the build.</p>
          </div>
          <label className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md font-medium text-sm hover:bg-blue-700 cursor-pointer transition-colors">
            {uploading ? "Uploading..." : "Upload photos"}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleUpload}
              disabled={uploading}
              className="hidden"
            />
          </label>
        </div>
      </div>

      {photos.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No photos uploaded yet. Click Upload photos to add some.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {photos.map((p) => (
            <div key={p.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="relative w-full h-48 bg-gray-100">
                {p.url ? (
                  <Image
                    src={p.url}
                    alt={p.caption || "Product photo"}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                    className="object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-sm text-gray-400">Image unavailable</div>
                )}
              </div>
              <div className="p-3">
                {editingCaptionId === p.id ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={captionDraft}
                      onChange={(e) => setCaptionDraft(e.target.value)}
                      placeholder="Add a caption..."
                      className="w-full px-2 py-1 border border-gray-300 rounded text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      autoFocus
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => {
                          setEditingCaptionId(null);
                          setCaptionDraft("");
                        }}
                        className="text-xs text-gray-600 hover:text-gray-900 font-medium"
                      >
                        Cancel
                      </button>
                      <button onClick={() => saveCaption(p.id)} className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => openCaptionEdit(p)} className="text-sm text-gray-700 hover:text-gray-900 text-left w-full block">
                    {p.caption || <span className="italic text-gray-400">Add a caption...</span>}
                  </button>
                )}
                <div className="flex justify-end mt-2">
                  <button onClick={() => handleDelete(p)} className="text-xs text-red-600 hover:text-red-800 font-medium">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}