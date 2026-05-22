export default function JobsPage() {
    return (
      <main className="min-h-screen bg-gray-900 text-white p-8">
        <div className="mb-8">
          <a href="/" className="text-blue-400 hover:underline">
            ← Dashboard
          </a>
        </div>
  
        <h1 className="text-4xl font-bold mb-8">
          Job Boards
        </h1>
  
        <div className="bg-gray-800 rounded-xl p-6">
          <h2 className="text-2xl font-semibold mb-4">
            Boards
          </h2>
  
          <div className="space-y-3">
            <div className="border border-gray-700 rounded-lg p-4">
              Nordson
            </div>
  
            <div className="border border-gray-700 rounded-lg p-4">
              Hotchkis
            </div>
  
            <div className="border border-gray-700 rounded-lg p-4">
              Eurowise
            </div>
  
            <div className="border border-gray-700 rounded-lg p-4">
              Misc
            </div>
          </div>
        </div>
      </main>
    );
  }