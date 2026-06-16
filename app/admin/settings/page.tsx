"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "../../lib/supabase";

export default function SettingsPage() {
  const supabase = createClient();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [companyName, setCompanyName] = useState("");
  const [burdenRate, setBurdenRate] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const { data: profile } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (!profile) {
      setLoading(false);
      return;
    }
    setCompanyId(profile.company_id);
    const { data: company } = await supabase
      .from("companies")
      .select("name, burden_rate_per_hour")
      .eq("id", profile.company_id)
      .single();
    if (company) {
      setCompanyName(company.name);
      setBurdenRate(String(company.burden_rate_per_hour));
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);

    if (!companyId) {
      setError("Could not determine your company. Try refreshing.");
      return;
    }
    if (!companyName.trim()) {
      setError("Company name is required.");
      return;
    }
    const rate = parseFloat(burdenRate);
    if (isNaN(rate) || rate < 0) {
      setError("Burden rate must be 0 or more.");
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from("companies")
      .update({ name: companyName.trim(), burden_rate_per_hour: rate })
      .eq("id", companyId);
    setSaving(false);

    if (error) {
      setError(error.message);
      return;
    }
    setMessage("Saved.");
    setTimeout(() => setMessage(null), 2000);
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-1">Settings</h1>
      <p className="text-gray-600 mb-6">Company details and labor costing.</p>

      <form onSubmit={handleSave} className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Company name</label>
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Burden rate ($ per labor hour)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={burdenRate}
            onChange={(e) => setBurdenRate(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">
            Your fully-loaded labor cost per hour (wages, taxes, benefits, overhead). Used to calculate labor cost on jobs from tracked time.
          </p>
        </div>

        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}
        {message && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-3">{message}</div>}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Save settings"}
          </button>
        </div>
      </form>
    </div>
  );
}