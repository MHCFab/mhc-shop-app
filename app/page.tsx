export default function Home() {
  return (
    <main className="min-h-screen bg-gray-900 text-white p-8">
      <h1 className="text-4xl font-bold mb-6">
        MHC Shop Management
      </h1>

      <div className="grid grid-cols-3 gap-6">
        <div className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-semibold mb-2">
            Active Jobs
          </h2>

          <p className="text-5xl font-bold">
            0
          </p>
        </div>

        <div className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-semibold mb-2">
            Employees Clocked In
          </h2>

          <p className="text-5xl font-bold">
            0
          </p>
        </div>

        <div className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-semibold mb-2">
            Jobs Due This Week
          </h2>

          <p className="text-5xl font-bold">
            0
          </p>
        </div>
      </div>

      <div className="mt-10 bg-gray-800 rounded-xl p-6">
        <h2 className="text-2xl font-semibold mb-4">
          Job Board
        </h2>

        <div className="border border-gray-700 rounded-lg p-4">
          No jobs yet
        </div>
      </div>
    </main>
  );
}