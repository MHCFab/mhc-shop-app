"use client";

import { useEffect, useState } from "react";
import { createClient } from "../../lib/supabase";

type Product = {
  id: string;
  name: string;
  product_number: string | null;
  description: string | null;
  is_sub_assembly: boolean;
};

export default function PortalProductsPage() {
  const supabase = createClient();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadProducts() {
    setLoading(true);
    const { data, error } = await supabase
      .from("product_templates")
      .select("id, name, product_number, description, is_sub_assembly")
      .order("name");
    if (error) setError(error.message);
    else {
      // Sub-assemblies are internal components, not orderable products
      const rows = ((data || []) as unknown as Product[]).filter((p) => !p.is_sub_assembly);
      setProducts(rows);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Your products</h1>
        <p className="text-gray-600 mt-1">The products we build for you. Ordering from this list is coming soon.</p>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">{error}</div>}

      {loading ? (
        <p className="text-gray-600">Loading...</p>
      ) : products.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-600">No products on file yet. Contact us to get your products set up.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Product #</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Name</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-700">Description</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 text-sm text-gray-700 font-mono">{p.product_number || "-"}</td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{p.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{p.description || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
