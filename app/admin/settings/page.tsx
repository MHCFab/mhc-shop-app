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
  const [invShowPurchasedParts, setInvShowPurchasedParts] = useState(true);
  const [invShowFabricated, setInvShowFabricated] = useState(true);
  const [invTrackGrade, setInvTrackGrade] = useState(true);
  const [invTrackWallThickness, setInvTrackWallThickness] = useState(true);

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

    const { data: invCompany } = await supabase
      .from("companies")
      .select("inv_show_purchased_parts, inv_show_fabricated, inv_track_grade, inv_track_wall_thickness")
      .eq("id", profile.company_id)
      .single();
    if (invCompany) {
      setInvShowPurchasedParts(invCompany.inv_show_purchased_parts !== false);
      setInvShowFabricated(invCompany.inv_show_fabricated !== false);
      setInvTrackGrade(invCompany.inv_track_grade !== false);
      setInvTrackWallThickness(invCompany.inv_track_wall_thickness !== false);
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

    await supabase
      .from("companies")
      .update({
        inv_show_purchased_parts: invShowPurchasedParts,
        inv_show_fabricated: invShowFabricated,
        inv_track_grade: invTrackGrade,
        inv_track_wall_thickness: invTrackWallThickness,
      })
      .eq("id", companyId);

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

        <div className="pt-4 border-t border-gray-200">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Inventory options</h2>
          <p className="text-xs text-gray-500 mb-4">Turn parts of the inventory system on or off for how a shop works. Everything is on by default.</p>
          <div className="space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={invShowPurchasedParts} onChange={(e) => setInvShowPurchasedParts(e.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300" />
              <span className="text-sm"><span className="block font-medium text-gray-800">Purchased parts</span><span className="block text-xs text-gray-500">Show the Purchased Parts tab for bought-in parts you stock.</span></span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={invShowFabricated} onChange={(e) => setInvShowFabricated(e.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300" />
              <span className="text-sm"><span className="block font-medium text-gray-800">Fabricated sub-assemblies</span><span className="block text-xs text-gray-500">Show the Fabricated tab for items you build from other parts.</span></span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={invTrackGrade} onChange={(e) => setInvTrackGrade(e.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300" />
              <span className="text-sm"><span className="block font-medium text-gray-800">Track material grade</span><span className="block text-xs text-gray-500">Record an alloy or grade on raw materials. Turn off if your stock has no grade.</span></span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={invTrackWallThickness} onChange={(e) => setInvTrackWallThickness(e.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300" />
              <span className="text-sm"><span className="block font-medium text-gray-800">Track wall thickness</span><span className="block text-xs text-gray-500">Record a wall thickness on raw materials. Turn off if you do not use tube or pipe.</span></span>
            </label>
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