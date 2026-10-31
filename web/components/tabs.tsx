"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// A team's pages, the current one marked for screen readers too.
export function Tabs({ links }: { links: { href: string; label: string; exact?: boolean }[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Team">
      <ul className="tabs">
        {links.map(({ href, label, exact }) => {
          const current = exact ? path === href : path === href || path.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link href={href} aria-current={current ? "page" : undefined}>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
