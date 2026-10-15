import Link from "next/link";
import { ID_LEN, G, PHYSICAL_MM, REQUIRED_DPI } from "@/lib/aztec-marker";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-md p-4">
        <div className="-mx-4 -mt-4 flex items-center justify-center border-b border-gray-100 px-4 py-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/witomark-logo.png" alt="Witomark" width={200} height={48} className="h-7 w-auto object-contain" />
        </div>

        <h1 className="mt-5 text-h2 font-bold text-black">Aztec-style square bullseye marker</h1>
        <p className="mt-1 text-body text-gray-500">
          {G}×{G} grid, {ID_LEN}-character capacity (RS-protected), concentric square bullseye
          finder with a radial orientation spoke. {PHYSICAL_MM}mm physical size at {REQUIRED_DPI.toFixed(0)} DPI.
        </p>

        <div className="mt-6 flex flex-col gap-3">
          <Link
            href="/generate"
            className="flex items-center justify-center rounded-full bg-black py-3 text-btn font-medium text-white"
          >
            Generate a marker
          </Link>
          <Link
            href="/decode"
            className="flex items-center justify-center rounded-full border border-black py-3 text-btn font-medium text-black"
          >
            Decode a marker
          </Link>
        </div>
      </div>
    </div>
  );
}
