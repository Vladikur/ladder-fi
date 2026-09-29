import Link from 'next/link';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

const STEPS = [
  {
    title: '1. Pick a pool',
    body: 'Browse pools by 5m trading volume and liquidity, or look one up directly by token or pool address.',
  },
  {
    title: '2. Configure your ladder',
    body: 'Choose a strategy (Bid-Ask, Spot, or Curve), a price range, and how many bins to split it into.',
  },
  {
    title: '3. Preview the allocation',
    body: 'See exactly how your deposit splits across bins before committing any funds on-chain.',
  },
  {
    title: '4. Execute',
    body: 'Approve once, then batch-mint every position in a single guided flow - with automatic retry for any chunk that fails.',
  },
];

const FEATURES = [
  {
    title: 'Multiple strategies',
    body: 'Bid-Ask, Spot, and Curve weighting, each with an adjustable curve parameter.',
  },
  {
    title: 'Batch minting',
    body: 'Mints many concentrated liquidity positions across a range in as few transactions as possible.',
  },
  {
    title: 'Live plan preview',
    body: 'A bin-by-bin chart shows exact token amounts before you sign anything.',
  },
  {
    title: 'Uniswap v3 & v4 forks',
    body: "Works against both of Robinhood Chain's Uniswap-family deployments.",
  },
  {
    title: 'Position management',
    body: 'Track, collect fees from, and withdraw your open positions from one panel.',
  },
  {
    title: 'Client-side reads',
    body: 'Pool and balance reads go straight to the chain from your browser, rate-limited only where it matters.',
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen">
      <Header />

      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-16 pt-20 text-center">
        <div className="mx-auto flex w-fit items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16">
            <rect width="16" height="16" fill="#cf0" rx="8" />
            <path
              fill="#000"
              d="M9.0731 5.6235c.0665.0001.0868.0403.04.0937-1.137 1.2574-2.9498 3.3574-4.6152 7.5977-.0134.0333-.0537.0537-.0937.0537h-.2207c-.0468-.0001-.0671-.029-.0537-.0811.2207-.8159.5222-1.719.997-3.0498V8.392c0-.3544.0536-.6016.2676-.8691l1.458-1.8057c.0515-.0642.114-.0937.1875-.0937z"
            />
            <path
              fill="#000"
              d="M9.4735 6.1332c.0468-.0534.0936-.0266.0938.04V8.729c0 .0334-.0064.0802-.0264.1201l-.9297 1.5313c-.1136.1871-.2463.2823-.4814.3545l-2.087.6426c-.0601.02-.0927-.0248-.0673-.0743 1.0099-1.973 2.1002-3.6116 3.498-5.1699"
            />
            <path
              fill="#000"
              d="M9.1327 3.5444c.6556-.254 2.0734-.2406 2.3877.0937.3543.3747.4005 1.2778.3203 1.8662-.0602.401-.127.488-.3477.7754l-1.3574 1.7725c-.0401.06-.0936.0403-.0937-.0264v-2.542c-.0001-.2072-.1209-.3271-.3282-.3271H7.46c-.0666-.0002-.0865-.0471-.04-.0938.3811-.4013.7828-.8093 1.3847-1.3242.0602-.0515.1917-.1415.3281-.1944"
            />
          </svg>
          Built for Robinhood Chain
        </div>

        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Bid-Ask concentrated liquidity ladders</h1>
        <p className="mx-auto max-w-2xl text-balance text-lg text-muted-foreground">
          LadderFi splits a single deposit into many concentrated liquidity positions across a price range in one guided flow -
          so you don&apos;t have to size and mint each bin by hand.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Button asChild size="lg">
            <Link href="/pools">Browse pools</Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <Link href="/positions">View positions</Link>
          </Button>
        </div>
      </section>

      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-16">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-semibold">What is LadderFi?</h2>
          <p className="mt-2 text-muted-foreground">
            Providing concentrated liquidity well usually means manually computing and minting several overlapping positions.
            LadderFi automates that: pick a range and a strategy, and it works out how much of each token belongs in every bin,
            then submits the mints for you.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-16">
        <h2 className="text-2xl font-semibold">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <Card key={step.title}>
              <CardHeader>
                <CardTitle>{step.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{step.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-16">
        <h2 className="text-2xl font-semibold">Features</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Card key={feature.title}>
              <CardHeader>
                <CardTitle>{feature.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{feature.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-16">
        <Card>
          <CardHeader>
            <CardTitle>Supported protocols</CardTitle>
            <CardDescription>Robinhood Chain (chain id 4663)</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              LadderFi supports both of Robinhood Chain&apos;s Uniswap-family deployments - a Uniswap v3 fork and Uniswap v4 -
              so you can build a ladder on whichever one hosts the pool you care about.
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24 text-center">
        <Button asChild size="lg">
          <Link href="/pools">Get started</Link>
        </Button>
      </section>
    </main>
  );
}
