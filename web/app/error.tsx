"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="narrow">
      <h1>Something went wrong</h1>
      <p>The page couldn&apos;t be shown. It may be the database, for a moment.</p>
      <p>
        <button type="button" onClick={() => reset()}>
          Try again
        </button>
      </p>
    </div>
  );
}
