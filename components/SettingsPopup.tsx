'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_MAX_GAS_FEE_USD, getMaxGasFeeUsd, setMaxGasFeeUsd } from '@/lib/settings';

export function SettingsPopup() {
  const [open, setOpen] = useState(false);
  const [maxGasFeeUsd, setMaxGasFeeUsdInput] = useState(String(DEFAULT_MAX_GAS_FEE_USD));

  useEffect(() => {
    if (open) setMaxGasFeeUsdInput(String(getMaxGasFeeUsd()));
  }, [open]);

  function save() {
    const value = Number(maxGasFeeUsd);
    if (!Number.isFinite(value) || value <= 0) return;
    setMaxGasFeeUsd(value);
    setOpen(false);
  }

  return (
    <div className="relative ml-auto">
      <button
        type="button"
        aria-label="Settings"
        onClick={() => setOpen((v) => !v)}
        className="rounded p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065Z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-lg">
            <h2 className="mb-3 text-sm font-semibold">Settings</h2>
            <label className="flex flex-col gap-1 text-sm">
              Max gas fee ($)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={maxGasFeeUsd}
                onChange={(e) => setMaxGasFeeUsdInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && save()}
                className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1"
              />
            </label>
            <p className="mt-1 text-xs text-neutral-500">Blocks any mint chunk whose estimated gas fee exceeds this, per execution step.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700">
                Cancel
              </button>
              <button type="button" onClick={save} className="rounded bg-blue-600 px-3 py-1 text-sm hover:bg-blue-500">
                Save
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
