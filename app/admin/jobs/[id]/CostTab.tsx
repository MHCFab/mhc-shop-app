"use client";

import { useEffect, useState, useCallback } from "react";
import { getJobCostReport, type JobCostReport } from "../../../lib/inventory";

function money(n: number) {
  return "$" + n.toFixed(2);
}

export default function CostTab({ jobId }: { jobId: string }) {
  const [report, setReport] = useState<JobCostReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await getJobCostReport(jobId);
    setReport(r);
    setLoading(false);
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p className="text-gray-600">Calculating...</p>;
  if (!report) return <p className="text-gray-600">No cost data.</p>;

  const profitPositive = report.netProfitTotal >= 0;
  const pricedBelow = report.retailTotal < report.suggestedRetailTotal;

  return (
    <div className="space-y-6">
      {/* Headline numbers */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Your cost (actual)</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{money(report.totalActualCost)}</div>
          <div className="text-xs text-gray-500 mt-1">{money(report.costPerUnit)} / unit</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium">Your retail price</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{money(report.retailTotal)}</div>
          <div className="text-xs text-gray-500 mt-1">{money(report.retailPerUnit)} / unit</div>
        </div>
        <div className={"rounded-lg p-4 border " + (profitPositive ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200")}>
          <div className={"text-xs uppercase tracking-wide font-medium " + (profitPositive ? "text-green-700" : "text-red-700")}>Net profit</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{money(report.netProfitTotal)}</div>
          <div className="text-xs text-gray-500 mt-1">{money(report.netProfitPerUnit)} / unit &middot; {report.marginPercent.toFixed(1)}% margin</div>
        </div>
      </div>

      {/* Actual cost breakdown */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-base font-semibold text-gray-900">Your actual cost</h3>
        </div>
        <table className="w-full">
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="px-4 py-3 text-sm text-gray-700">Labor ({report.laborHours.toFixed(2)} hrs × {money(report.burdenRate)}/hr)</td>
              <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{money(report.laborCost)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="px-4 py-3 text-sm text-gray-700">Material (actual consumed)</td>
              <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{money(report.materialActualCost)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="px-4 py-3 text-sm text-gray-700">Parts (actual used)</td>
              <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{money(report.partsActualCost)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="px-4 py-3 text-sm text-gray-500 pl-8">of which scrap</td>
              <td className="px-4 py-3 text-sm text-gray-500 text-right font-mono">{money(report.scrapCost)}</td>
            </tr>
            {(report.fabricatedActualCost > 0 || report.estimateFabricatedCost > 0) && (
              <tr className="border-b border-gray-100">
                <td className="px-4 py-3 text-sm text-gray-700">Fabricated sub-assemblies (pulled from stock)</td>
                <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{money(report.fabricatedActualCost)}</td>
              </tr>
            )}
            <tr className="bg-gray-50">
              <td className="px-4 py-3 text-sm font-semibold text-gray-900">Total cost</td>
              <td className="px-4 py-3 text-sm font-bold text-gray-900 text-right font-mono">{money(report.totalActualCost)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Pricing comparison */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-base font-semibold text-gray-900">Pricing</h3>
        </div>
        <table className="w-full">
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="px-4 py-3 text-sm text-gray-700">Your retail price</td>
              <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{money(report.retailTotal)}</td>
              <td className="px-4 py-3 text-sm text-gray-500 text-right font-mono">{money(report.retailPerUnit)}/unit</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="px-4 py-3 text-sm text-gray-700">Suggested retail (markup {report.markupPercent.toFixed(0)}% + {money(report.shopLaborRate)}/hr labor)</td>
              <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{money(report.suggestedRetailTotal)}</td>
              <td className="px-4 py-3 text-sm text-gray-500 text-right font-mono">{money(report.suggestedRetailPerUnit)}/unit</td>
            </tr>
          </tbody>
        </table>
        {pricedBelow && report.retailTotal > 0 && (
          <div className="px-4 py-3 bg-amber-50 border-t border-amber-200">
            <p className="text-sm text-amber-800">Your price is below the suggested retail. You may be leaving margin on the table.</p>
          </div>
        )}
      </div>

      {/* Estimate vs actual */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-base font-semibold text-gray-900">Estimate vs actual cost</h3>
        </div>
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-700 uppercase"></th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-700 uppercase">Estimate</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-700 uppercase">Actual</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="px-4 py-3 text-sm text-gray-700">Material</td>
              <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{money(report.estimateMaterialCost)}</td>
              <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{money(report.materialActualCost)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="px-4 py-3 text-sm text-gray-700">Parts</td>
              <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{money(report.estimatePartsCost)}</td>
              <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{money(report.partsActualCost)}</td>
            </tr>
            {(report.fabricatedActualCost > 0 || report.estimateFabricatedCost > 0) && (
              <tr className="border-b border-gray-100">
                <td className="px-4 py-3 text-sm text-gray-700">Fabricated sub-assemblies</td>
                <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{money(report.estimateFabricatedCost)}</td>
                <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{money(report.fabricatedActualCost)}</td>
              </tr>
            )}
            <tr className="border-b border-gray-100">
              <td className="px-4 py-3 text-sm text-gray-700">Labor</td>
              <td className="px-4 py-3 text-sm text-gray-700 text-right font-mono">{money(report.estimateLaborCost)}</td>
              <td className="px-4 py-3 text-sm text-gray-900 text-right font-mono">{money(report.laborCost)}</td>
            </tr>
            <tr className="bg-gray-50">
              <td className="px-4 py-3 text-sm font-semibold text-gray-900">Total</td>
              <td className="px-4 py-3 text-sm font-bold text-gray-900 text-right font-mono">{money(report.totalEstimate)}</td>
              <td className="px-4 py-3 text-sm font-bold text-gray-900 text-right font-mono">{money(report.totalActualCost)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}