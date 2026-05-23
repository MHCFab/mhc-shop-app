export default function Home() {
  return (
    <main className="min-h-screen bg-gray-900 text-white p-8">
      <h1 className="text-4xl font-bold mb-8">
        MHC Shop Management
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <a
          href="/jobs"
          className="bg-gray-800 hover:bg-gray-700 rounded-xl p-8"
        >
          <h2 className="text-2xl font-semibold mb-2">
            Job Boards
          </h2>

          <p className="text-gray-400">
            Create jobs and track workflow.
          </p>
        </a>

        <a
          href="/product-templates"
          className="bg-gray-800 hover:bg-gray-700 rounded-xl p-8"
        >
          <h2 className="text-2xl font-semibold mb-2">
            Products
          </h2>

          <p className="text-gray-400">
            Build product templates and SOPs.
          </p>
        </a>

        <a
          href="/cost-sheets"
          className="bg-gray-800 hover:bg-gray-700 rounded-xl p-8"
        >
          <h2 className="text-2xl font-semibold mb-2">
            Cost Sheets
          </h2>

          <p className="text-gray-400">
            Manage raw material and part costs.
          </p>
        </a>
      </div>
    </main>
  );
}