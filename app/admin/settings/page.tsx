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
  const [shopLaborRate, setShopLaborRate] = useState("");
  const [markup, setMarkup] = useState("");

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
      .select("name, burden_rate_per_hour, shop_labor_rate_per_hour, material_markup_percent")
      .eq("id", profile.company_id)
      .single();
    if (company) {
      setCompanyName(company.name);
      setBurdenRate(String(company.burden_rate_per_hour));
      setShopLaborRate(String(company.shop_labor_rate_per_hour));
      setMarkup(String(company.material_markup_percent));
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
    const burden = parseFloat(burdenRate);
    const shop = parseFloat(shopLaborRate);
    const mk = parseFloat(markup);
    if (isNaN(burden) || burden < 0) {
      setError("Burden rate must be 0 or more.");
      return;
    }
    if (isNaN(shop) || shop < 0) {
      setError("Shop labor rate must be 0 or more.");
      return;
    }
    if (isNaN(mk) || mk < 0) {
      setError("Markup must be 0 or more.");
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from("companies")
      .update({
        name: companyName.trim(),
        burden_rate_per_hour: burden,
        shop_labor_rate_per_hour: shop,
        material_markup_percent: mk,
      })
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
      <p className="text-gray-600 mb-6">Company details, labor costing, and customer pricing.</p>

      <form onSubmit={handleSave} className="bg-white border border-gray-200 rounded-lg p-5 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Company name</label>
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="pt-4 border-t border-gray-200">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Internal cost</h2>
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
            Your fully-loaded labor cost per hour. Used to calculate what a job actually costs you.
          </p>
        </div>

        <div className="pt-4 border-t border-gray-200">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Customer pricing</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Shop labor rate ($ per hour)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={shopLaborRate}
                onChange={(e) => setShopLaborRate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">What you charge customers per labor hour. Used for the suggested retail price.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Material &amp; parts markup (%)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={markup}
                onChange={(e) => setMarkup(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">Markup applied to material and parts for the suggested retail price. Enter 20 for a 20% markup (cost × 1.20).</p>
            </div>
          </div>
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