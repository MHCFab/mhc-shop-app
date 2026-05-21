"use client";

import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

export default function Home() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [customers, setCustomers] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [description, setDescription] = useState("");
  const [sopText, setSopText] = useState("");
  async function fetchCustomers() {
    const { data } = await supabase
      .from("customers")
      .select("*")
      .order("created_at", { ascending: false });
  
    if (data) {
      setCustomers(data);
    }
  }
  async function fetchProducts() {
    const { data } = await supabase
      .from("products")
      .select("*, customers(name)")
      .order("created_at", { ascending: false });
  
    if (data) {
      setProducts(data);
    }
  }
  async function fetchJobs() {
    const { data } = await supabase
      .from("jobs")
      .select("*");

    if (data) {
      setJobs(data);
    }
  }

  async function addCustomer() {
    if (!customerName) return;

    await supabase.from("customers").insert([
      {
        name: customerName,
      },
    ]);

    alert("Customer added");

    setCustomerName("");
    fetchCustomers();
  }

  useEffect(() => {
    fetchJobs();
    fetchCustomers();
    fetchProducts();
  }, []);
  
  return (
    <main className="min-h-screen bg-gray-900 text-white p-8">
      <h1 className="text-4xl font-bold mb-8">
        MHC Shop Management
      </h1>

      <div className="bg-gray-800 rounded-xl p-6 mb-8">
        <h2 className="text-2xl font-semibold mb-4">
          Add Customer
        </h2>

        <div className="flex gap-4">
          <input
            type="text"
            placeholder="Customer Name"
            value={customerName}
            onChange={(e) =>
              setCustomerName(e.target.value)
            }
            className="flex-1 p-3 rounded-lg bg-gray-700 border border-gray-600"
          />

          <button
            onClick={addCustomer}
            className="bg-blue-600 hover:bg-blue-500 px-6 py-3 rounded-lg font-semibold"
          >
            Add
          </button>
        </div>
        <div className="mt-6">
  <h3 className="text-xl font-semibold mb-3">
    Customers
  </h3>

  <div className="space-y-2">
    {customers.length > 0 ? (
      customers.map((customer) => (
        <div
          key={customer.id}
          className="border border-gray-700 rounded-lg p-3"
        >
          {customer.name}
        </div>
      ))
    ) : (
      <div className="text-gray-400">
        No customers yet
      </div>
    )}
  </div>
</div>
      </div>

      <div className="bg-gray-800 rounded-xl p-6">
        <h2 className="text-2xl font-semibold mb-4">
          Job Board
        </h2>

        <div className="space-y-4">
          {jobs.length > 0 ? (
            jobs.map((job) => (
              <div
                key={job.id}
                className="border border-gray-700 rounded-lg p-4"
              >
                <p className="text-xl font-bold">
                  Job #{job.id.slice(0, 8)}
                </p>

                <p>
                  Quantity: {job.quantity}
                </p>

                <p>
                  Status: {job.status}
                </p>
              </div>
            ))
          ) : (
            <div className="border border-gray-700 rounded-lg p-4">
              No jobs yet
            </div>
          )}
        </div>
      </div>
    </main>
  );
}