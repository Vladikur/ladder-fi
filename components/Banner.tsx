export function Banner() {
  return (
    <div className="border-b border-amber-900/50 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
      <strong>Experimental tool, hot wallet.</strong> This app holds a live private key with no manual
      confirmation step and can lose funds to bugs, chain reorgs, or impermanent loss. Test on a fork or with
      small amounts first. It gives no financial advice and does not forecast returns.
    </div>
  );
}
