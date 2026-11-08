'use client';

import {
  BottomBar,
  groupItems,
  InboxBell,
  ServiceSearch,
  ShellMenu,
  type DeskItem,
  type ShellMenuProps,
} from '@sepehr/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const HOME = { href: '/', label: 'پیشخوان' };

/** The ☰ menu of the panel, the page you are on marked (owner 1405/08/10). */
export function AdminMenu({
  items,
  ...props
}: Omit<ShellMenuProps, 'groups' | 'currentPath' | 'link' | 'home' | 'label'> & {
  items: readonly DeskItem[];
}) {
  return (
    <ShellMenu
      {...props}
      label="بخش‌های پنل داخلی"
      home={HOME}
      groups={groupItems(items)}
      currentPath={usePathname()}
      link={Link}
    />
  );
}

export function AdminSearch({ items }: { items: readonly DeskItem[] }) {
  return <ServiceSearch items={items} link={Link} />;
}

export function AdminBottomBar({ items }: { items: readonly DeskItem[] }) {
  return (
    <BottomBar
      home={{ href: '/', label: 'خانه' }}
      items={items}
      currentPath={usePathname()}
      link={Link}
    />
  );
}

/** The bell and its drawer of the account's own notifications (owner 1405/08/10). */
export function AdminBell() {
  return <InboxBell link={Link} />;
}
