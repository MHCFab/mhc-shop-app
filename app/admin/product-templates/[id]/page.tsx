"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "../../../lib/supabase";
import BillOfMaterialsTab from "./BillOfMaterialsTab";
import TasksTab from "./TasksTab";
import PhotosTab from "./PhotosTab";
import NotesTab from "./NotesTab";
import SettingsTab from "./SettingsTab";

type ProductTemplate = {
  id: string;
  name: string;
  product_number: string | null;
  description: string | null;
  sops: string | null;
  is_active: boolean;
};

type Tab = "bom" | "tasks" | "photos" | "notes" | "settings";

export default function ProductTemplateDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const supabase = createClient();

  const [template, setTemplate] = useState<ProductTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("bom");

  const loadTemplate = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("product_templates")
      .select("*")
      .eq("id", id)
      .single();
    if (error) setError(error.message);
    else setTemplate(data);
    setLoading(false);
  }, [id, supabase]);

  useEffect(() => {
    loadTemplate();
  }, [loadTemplate]);

  const tabs: { value: Tab; label: string }[] = [
    { value: "bom", label: "Bill of Materials" },
    { value: "tasks", label: "Tasks" },
    { value: "photos", label: "Photos" },
    { value: "notes", label: "Build Notes" },
    { value: "settings", label: "Settings" },
  ];

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <Link href="/admin/product-templates" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
          &larr; Back to product templates
        </Link>
        <div className="bg-red-50 border border-red-200 rounded-md p-4 text-red-700">
          {error || "Product template not found."}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <Link href="/admin/product-templates" className="text-sm text-blue-600 hover:text-blue-800 mb-4 inline-block">
        &larr; Back to product templates
      </Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{template.name}</h1>
          {template.product_number && <p className="text-gray-500 mt-1">{template.product_number}</p>}
          {template.description && <p className="text-gray-700 mt-2 max-w-3xl">{template.description}</p>}
        </div>
        {template.is_active ? (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">Active</span>
        ) : (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-600">Inactive</span>
        )}
      </div>

      <div className="border-b border-gray-200 mb-6">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                tab === t.value
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-gray-600 hover:text-gray-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "bom" && <BillOfMaterialsTab templateId={template.id} />}
      {tab === "tasks" && <TasksTab templateId={template.id} />}
      {tab === "photos" && <PhotosTab templateId={template.id} />}
      {tab === "notes" && <NotesTab templateId={template.id} />}
      {tab === "settings" && <SettingsTab templateId={template.id} />}
    </div>
  );
}