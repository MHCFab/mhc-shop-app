"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { createClient } from "../../lib/supabase";

type Employee = {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
};

type Invitation = {
  id: string;
  email: string;
  full_name: string | null;
  status: string;
  created_at: string;
};

export default function EmployeesPage() {
  const supabase = createClient();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"active" | "inactive">("active");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  // Inline name editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // Per-row action feedback
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    const { data: userData } = await supabase.auth.getUser();
    setCurrentUserId(userData.user?.id ?? null);
    const [empRes, invRes] = await Promise.all([
      supabase.from("profiles").select("id, email, full_name, role, is_active, created_at").order("full_name"),
      supabase.from("employee_invitations").select("id, email, full_name, status, created_at").eq("status", "pending").order("created_at", { ascending: false }),
    ]);
    if (empRes.error) setError(empRes.error.message);
    else setEmployees((empRes.data || []) as Employee[]);
    setInvitations((invRes.data || []) as Invitation[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function flash(msg: string) {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setInviteSuccess(null);

    if (!inviteEmail.trim()) {
      setInviteError("Email is required.");
      return;
    }

    setInviting(true);
    try {
      const res = await fetch("/api/invite-employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), fullName: inviteName.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setInviteError(data.error || "Failed to send invite.");
        setInviting(false);
        return;
      }
      setInviteSuccess("Invite sent to " + inviteEmail.trim() + ".");
      setInviteEmail("");
      setInviteName("");
      setInviting(false);
      loadData();
    } catch {
      setInviteError("Something went wrong sending the invite.");
      setInviting(false);
    }
  }

  async function resendInvite(inv: Invitation) {
    setBusyId(inv.id);
    try {
      const res = await fetch("/api/invite-employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inv.email, fullName: inv.full_name }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert("Failed to resend: " + (data.error || "Unknown error"));
      } else {
        flash("Invite resent to " + inv.email + ".");
      }
    } catch {
      alert("Something went wrong resending the invite.");
    }
    setBusyId(null);
  }

  async function cancelInvite(inv: Invitation) {
    if (!confirm("Cancel the invite for " + inv.email + "?")) return;
    setBusyId(inv.id);
    const { error } = await supabase.from("employee_invitations").update({ status: "cancelled" }).eq("id", inv.id);
    setBusyId(null);
    if (error) {
      alert("Failed to cancel: " + error.message);
      return;
    }
    loadData();
  }

  async function toggleActive(emp: Employee) {
    setBusyId(emp.id);
    const { error } = await supabase.from("profiles").update({ is_active: !emp.is_active }).eq("id", emp.id);
    setBusyId(null);
    if (error) {
      alert("Failed to update: " + error.message);
      return;
    }
    loadData();
  }

  async function makeAdmin(emp: Employee) {
    if (!confirm("Give " + (emp.full_name || emp.email) + " full admin access? They'll be able to manage employees, settings, and all company data.")) return;
    setBusyId(emp.id);
    const { error } = await supabase.from("profiles").update({ role: "admin" }).eq("id", emp.id);
    setBusyId(null);
    if (error) {
      alert("Failed to update: " + error.message);
      return;
    }
    flash((emp.full_name || emp.email) + " is now an admin.");
    loadData();
  }

  async function removeAdmin(emp: Employee) {
    if (emp.id === currentUserId) {
      alert("You can't remove your own admin access.");
      return;
    }
    if (!confirm("Remove admin access from " + (emp.full_name || emp.email) + "? They'll go back to a regular employee.")) return;
    setBusyId(emp.id);
    const { error } = await supabase.from("profiles").update({ role: "employee" }).eq("id", emp.id);
    setBusyId(null);
    if (error) {
      alert("Failed to update: " + error.message);
      return;
    }
    flash("Removed admin access from " + (emp.full_name || emp.email) + ".");
    loadData();
  }

  function openEditName(emp: Employee) {
    setEditingId(emp.id);
    setEditName(emp.full_name || "");
  }

  async function saveEditName(emp: Employee) {
    setBusyId(emp.id);
    const { error } = await supabase.from("profiles").update({ full_name: editName.trim() || null }).eq("id", emp.id);
    setBusyId(null);
    if (error) {
      alert("Failed to save: " + error.message);
      return;
    }
    setEditingId(null);
    loadData();
  }

  async function sendPasswordReset(emp: Employee) {
    setBusyId(emp.id);
    const redirectTo = window.location.origin + "/reset-password";
    const { error } = await supabase.auth.resetPasswordForEmail(emp.email, { redirectTo });
    setBusyId(null);
    if (error) {
      alert("Failed to send reset: " + error.message);
      return;
    }
    flash("Password reset email sent to " + emp.email + ".");
  }

  async function deleteEmployee(emp: Employee) {
    if (!confirm("Permanently remove " + (emp.full_name || emp.email) + "? This deletes their account entirely and cannot be undone. (To just disable login, use Deactivate instead.)")) return;
    setBusyId(emp.id);
    try {
      const res = await fetch("/api/delete-employee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: emp.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert("Failed to remove: " + (data.error || "Unknown error"));
      } else {
        flash("Removed " + (emp.full_name || emp.email) + ".");
      }
    } catch {
      alert("Something went wrong removing the employee.");
    }
    setBusyId(null);
    loadData();
  }

  const visibleEmployees = employees.filter((e) =>
    statusFilter === "active" ? e.is_active : !e.is_active
  );

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Employees</h1>
          <p className="text-gray-600 mt-1">Invite your crew and manage who has access.</p>
        </div>
        <button onClick={() => { setShowInvite(true); setInviteError(null); setInviteSuccess(null); }} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition-colors">
          Invite employee
        </button>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">{error}</div>}
      {actionMsg && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-3 mb-4">{actionMsg}</div>}

      {invitations.length > 0 && (
        <section className="bg-white border border-gray-200 rounded-lg overflow-hidden mb-6">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h3 className="text-base font-semibold text-gray-900">Pending invites</h3>
          </div>
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Name</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Email</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Sent</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-sm text-gray-900">{inv.full_name || "-"}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{inv.email}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{new Date(inv.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                    <button onClick={() => resendInvite(inv)} disabled={busyId === inv.id} className="text-blue-600 hover:text-blue-800 font-medium mr-3 disabled:opacity-50">Resend</button>
                    <button onClick={() => cancelInvite(inv)} disabled={busyId === inv.id} className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50">Cancel</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => setStatusFilter("active")}
          className={"px-3 py-1.5 rounded-md text-sm font-medium " + (statusFilter === "active" ? "bg-blue-600 text-white" : "bg-white border border-gray-300 text-gray-700 hover:bg-gray-50")}
        >
          Active
        </button>
        <button
          onClick={() => setStatusFilter("inactive")}
          className={"px-3 py-1.5 rounded-md text-sm font-medium " + (statusFilter === "inactive" ? "bg-blue-600 text-white" : "bg-white border border-gray-300 text-gray-700 hover:bg-gray-50")}
        >
          Inactive
        </button>
      </div>

      <section className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-base font-semibold text-gray-900">{statusFilter === "active" ? "Active team" : "Inactive team"}</h3>
        </div>
        {visibleEmployees.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-600">{statusFilter === "active" ? "No active team members." : "No inactive team members."}</p>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Name</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Email</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Role</th>
                <th className="text-right px-4 py-3 text-sm font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleEmployees.map((emp) => {
                const isEditing = editingId === emp.id;
                const busy = busyId === emp.id;
                return (
                  <tr key={emp.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 text-sm">
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="px-2 py-1 border border-gray-300 rounded text-gray-900 text-sm"
                            placeholder="Full name"
                          />
                          <button onClick={() => saveEditName(emp)} disabled={busy} className="text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50">Save</button>
                          <button onClick={() => setEditingId(null)} className="text-gray-600 hover:text-gray-900 font-medium">Cancel</button>
                        </div>
                      ) : (
                        <Link href={"/admin/employees/" + emp.id} className="text-blue-600 hover:text-blue-800 font-medium">{emp.full_name || "(no name)"}</Link>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">{emp.email}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className={"inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium " + (emp.role === "admin" ? "bg-purple-100 text-purple-800" : "bg-gray-100 text-gray-700")}>
                        {emp.role === "admin" ? "Admin" : "Employee"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-right whitespace-nowrap">
                      {emp.role === "admin" ? (
                        emp.id === currentUserId ? (
                          <span className="text-gray-400">(you)</span>
                        ) : (
                          <button onClick={() => removeAdmin(emp)} disabled={busy} className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50">Remove admin</button>
                        )
                      ) : isEditing ? null : (
                        <>
                          <button onClick={() => openEditName(emp)} disabled={busy} className="text-blue-600 hover:text-blue-800 font-medium mr-3 disabled:opacity-50">Edit</button>
                          <button onClick={() => sendPasswordReset(emp)} disabled={busy} className="text-blue-600 hover:text-blue-800 font-medium mr-3 disabled:opacity-50">Reset password</button>
                          <button onClick={() => makeAdmin(emp)} disabled={busy} className="text-purple-700 hover:text-purple-900 font-medium mr-3 disabled:opacity-50">Make admin</button>
                          <button onClick={() => toggleActive(emp)} disabled={busy} className="text-amber-700 hover:text-amber-900 font-medium mr-3 disabled:opacity-50">
                            {emp.is_active ? "Deactivate" : "Reactivate"}
                          </button>
                          <button onClick={() => deleteEmployee(emp)} disabled={busy} className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50">Remove</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {showInvite && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <form onSubmit={sendInvite} className="p-6 space-y-4">
              <h2 className="text-xl font-bold text-gray-900">Invite employee</h2>
              <p className="text-sm text-gray-600">They&apos;ll get an email with a link to set their password and join your shop.</p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full name</label>
                <input type="text" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Optional" className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email <span className="text-red-600">*</span></label>
                <input type="email" required value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              {inviteError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">{inviteError}</div>}
              {inviteSuccess && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-3">{inviteSuccess}</div>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowInvite(false)} className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md font-medium">Close</button>
                <button type="submit" disabled={inviting} className="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50">{inviting ? "Sending..." : "Send invite"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
