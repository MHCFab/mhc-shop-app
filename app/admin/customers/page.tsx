"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "../../lib/supabase";

type Customer = {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  labor_rate_per_hour: number | null;
};

type Form = {
  name: string;
  contact_name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  is_active: boolean;
  labor_rate: string;
};

const emptyForm: Form = {
  name: "",
  contact_name: "",
  phone: "",
  email: "",
  address: "",
  notes: "",
  is_active: true,
  labor_rate: "",
};

export default function CustomersPage() {
  const supabase = createClient();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);

  // Portal invite modal state
  const [inviteFor, setInviteFor] = useState<Customer | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  async function loadCompanyId() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase.from("profiles").select("company_id").eq("id", user.id).single();
    if (data) setCompanyId(data.company_id);
  }

  async function loadCustomers() {
    setLoading(true);
    const { data, error } = await supabase.from("customers").select("*").order("name");
    if (error) setError(error.message);
    else setCustomers(data || []);
    setLoading(false);
  }

  useEffect(() => {
    loadCompanyId();
    loadCustomers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    if (!search) return customers;
    const s = search.toLowerCase();
    return customers.filter((c) =>
      (c.name + " " + (c.contact_name || "") + " " + (c.email || "")).toLowerCase().includes(s)
    );
  }, [customers, search]);

  function openNew() {
    setForm(emptyForm);
    setEditingId(null);
    setError(null);
    setShowForm(true);
  }

  function openEdit(c: Customer) {
    setForm({
      name: c.name,
      contact_name: c.contact_name || "",
      phone: c.phone || "",
      email: c.email || "",
      address: c.address || "",
      notes: c.notes || "",
      is_active: c.is_active,
      labor_rate: c.labor_rate_per_hour != null ? String(c.labor_rate_per_hour) : "",
    });
    setEditingId(c.id);
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  }

  function openInvite(c: Customer) {
    setInviteFor(c);
    setInviteEmail(c.email || "");
    setInviteName(c.contact_name || "");
    setInviteError(null);
    setInviteSuccess(null);
  }

  function closeInvite() {
    setInviteFor(null);
    setInviteEmail("");
    setInviteName("");
    setInviteError(null);
    setInviteSuccess(null);
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteFor) return;
    setInviteError(null);
    setInviteSuccess(null);

    const email = inviteEmail.trim();
    if (!email) {
      setInviteError("Email is required.");
      return;
    }

    setInviteSending(true);
    try {
      const res = await fetch("/api/invite-customer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: inviteFor.id,
          email,
          fullName: inviteName.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setInviteError(body.error || "Failed to send the invite.");
      } else {
        setInviteSuccess(
          "Invite sent to " + email + ". They'll get an email with a link to set their password." +
          (body.warning ? " (" + body.warning + ")" : "")
        );
      }
    } catch {
      setInviteError("Failed to send the invite. Check your connection and try again.");
    }
    setInviteSending(false);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    if (!form.name.trim()) {
      setError("Name is required.");
      setSaving(false);
      return;
    }
    if (!companyId) {
      setError("Could not determine your company. Try refreshing the page.");
      setSaving(false);
      return;
    }

    let laborRate: number | null = null;
    if (form.labor_rate.trim() !== "") {
      const r = Number(form.labor_rate);
      if (!Number.isFinite(r) || r < 0) {
        setError("Labor rate must be a number of 0 or more, or left blank.");
        setSaving(false);
        return;
      }
      laborRate = r;
    }

    const payload = {
      name: form.name.trim(),
      contact_name: form.contact_name.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      notes: form.notes.trim() || null,
      is_active: form.is_active,
      labor_rate_per_hour: laborRate,
    };

    const { error } = editingId
      ? await supabase.from("customers").update(payload).eq("id", editingId)
      : await supabase.from("customers").insert({ ...payload, company_id: companyId });

    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    closeForm();
    loadCustomers();
  }

  async function handleDelete(c: Customer) {
    if (!confirm("Delete " + c.name + "? This cannot be undone.")) return;
    const { error } = await supabase.from("customers").delete().eq("id", c.id);
    if (error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    loadCustomers();
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Customers</h1>
          <p className="text-gray-600 mt-1">The companies and contacts you build jobs for.</p>
        </div>
        <button onClick={openNew} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors">
          Add customer
        </button>
      </div>

      <input
        type="text"
        placeholder="Search by name, contact, or email..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
      />

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">
            {customers.length === 0 ? "No customers yet. Click Add customer to add your first one." : "No customers match your search."}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Name</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Contact</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Phone</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Email</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Labor rate</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Status</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-sm text-gray-900 font-medium">{c.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{c.contact_name || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{c.phone || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{c.email || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {c.labor_rate_per_hour != null ? "$" + Number(c.labor_rate_per_hour).toFixed(2) + "/hr" : <span className="text-gray-400">Default</span>}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {c.is_active ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Active</span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                    <button onClick={() => openInvite(c)} className="text-green-700 hover:text-green-900 font-medium mr-3">Portal invite</button>
                    <button onClick={() => openEdit(c)} className="text-blue-600 hover:text-blue-800 font-medium mr-3">Edit</button>
                    <button onClick={() => handleDelete(c)} className="text-red-600 hover:text-red-800 font-medium">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSave} className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">{editingId ? "Edit customer" : "Add customer"}</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Contact name</label>
                  <input
                    type="text"
                    value={form.contact_name}
                    onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                    <input
                      type="tel"
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                    <input
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Labor rate ($ per hour)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Leave blank to use the shop default"
                    value={form.labor_rate}
                    onChange={(e) => setForm({ ...form, labor_rate: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Used for this customer&apos;s suggested retail price. Blank = the shop labor rate from Settings.</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                  <textarea
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">Active (uncheck to hide from new jobs)</span>
                </label>

                {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{error}</div>}
              </div>

              <div className="flex justify-end gap-2 mt-6">
                <button type="button" onClick={closeForm} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {inviteFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleInvite} className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-1">Invite to customer portal</h2>
              <p className="text-sm text-gray-600 mb-4">
                Send {inviteFor.name} a login for the customer portal. They&apos;ll be able to see
                their own jobs and products &mdash; nothing else.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email <span className="text-red-600">*</span>
                  </label>
                  <input
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    type="text"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">The person&apos;s name, shown in the portal header.</p>
                </div>

                {inviteError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{inviteError}</div>}
                {inviteSuccess && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-3">{inviteSuccess}</div>}
              </div>

              <div className="flex justify-end gap-2 mt-6">
                <button type="button" onClick={closeInvite} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium transition-colors">
                  {inviteSuccess ? "Close" : "Cancel"}
                </button>
                {!inviteSuccess && (
                  <button type="submit" disabled={inviteSending} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
                    {inviteSending ? "Sending..." : "Send invite"}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
