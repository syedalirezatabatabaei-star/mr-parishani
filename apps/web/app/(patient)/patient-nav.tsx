'use client';

import {
  BottomBar,
  groupItems,
  InboxBell,
  ShellMenu,
  type DeskItem,
  type ShellMenuProps,
} from '@sepehr/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const HOME = { href: '/me', label: 'پیشخوان' };

/** The patient's ☰ menu, the page you are on marked (owner 1405/08/10). */
export function PatientMenu({
  items,
  ...props
}: Omit<ShellMenuProps, 'groups' | 'currentPath' | 'link' | 'home' | 'label'> & {
  items: readonly DeskItem[];
}) {
  return (
    <ShellMenu
      {...props}
      label="بخش‌های حساب من"
      home={HOME}
      groups={groupItems(items)}
      currentPath={usePathname()}
      link={Link}
    />
  );
}

export function PatientBottomBar({ items }: { items: readonly DeskItem[] }) {
  return (
    <BottomBar
      home={{ href: HOME.href, label: 'خانه' }}
      items={items}
      currentPath={usePathname()}
      link={Link}
    />
  );
}

/** The bell and its drawer of the account's own notifications (owner 1405/08/10). */
export function PatientBell() {
  return <InboxBell link={Link} />;
}
