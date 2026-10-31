import Link from "next/link";

export default function NotFound() {
  return (
    <div className="narrow">
      <h1>Not found</h1>
      <p>There&apos;s nothing here, or it isn&apos;t yours to see.</p>
      <p>
        <Link href="/">Back to your teams</Link>
      </p>
    </div>
  );
}
